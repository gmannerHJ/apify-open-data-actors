import { Actor, log } from 'apify';
import { MARKETS, STOCK_MARKETS, DEFAULT_COLUMNS, EXTRA_COLUMNS, KNOWN_COLUMNS, PRESETS, OPERATIONS, ARRAY_RIGHT_OPERATIONS, NO_RIGHT_OPERATIONS } from './columns.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SCANNER = 'https://scanner.tradingview.com';
const MIN_GAP_MS = 1000; // one request per second
const REQUEST_TIMEOUT_MS = 45000;
const PAGE_SIZE = 500;
const MAX_RESULTS_CAP = 20000;
const MAX_COLUMNS = 200;
const SNAPSHOT_BATCH = 200;
const FIELD_SAMPLE_ROWS = 3;
const MODES = ['screener', 'snapshot', 'fields'];
const COLUMN_NAME = /^[A-Za-z0-9_.|%\-[\]]+$/;
const SYMBOL = /^[A-Z0-9_\-]+:[A-Z0-9_.\-!&/+^]+$/;

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- http ----------

let lastRequestAt = 0;
async function pace() {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
}

async function scannerRequest(path, body, { attempts = 4, okStatuses = [] } = {}) {
    const url = `${SCANNER}${path}`;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await pace();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: body ? 'POST' : 'GET',
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
                headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
            });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 10000 : 3000) * attempt;
                if (attempt < attempts) {
                    log.warning(`scanner ${res.status} on ${path} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                    await sleep(delay);
                }
                continue;
            }
            if (okStatuses.includes(res.status)) return { status: res.status, json: null };
            if (res.status === 400) {
                let message = text.slice(0, 300);
                try { message = JSON.parse(text).error || message; } catch { /* keep raw text */ }
                throw new InputError(`TradingView scanner rejected the request (400): ${message}`);
            }
            if (res.status === 404) throw new InputError(`TradingView scanner has no endpoint ${path} (404); check the market name.`);
            if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
            return { status: 200, json: JSON.parse(text) };
        } catch (e) {
            if (e instanceof InputError || /^HTTP \d+ from/.test(e.message)) throw e;
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`) : e;
            if (attempt < attempts) await sleep(3000 * attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${url} failed after ${attempts} attempts (${lastError?.message})`);
}

// ---------- rows ----------

function toRow(item, columns, market, asOf) {
    const symbol = String(item.s ?? '');
    const colon = symbol.indexOf(':');
    const row = { symbol, exchange: colon > 0 ? symbol.slice(0, colon) : null, name: null, market };
    const values = Array.isArray(item.d) ? item.d : [];
    columns.forEach((c, i) => { row[c] = values[i] === undefined ? null : values[i]; });
    if (typeof row.name !== 'string' || !row.name) row.name = colon > 0 ? symbol.slice(colon + 1) : symbol;
    row.asOf = asOf;
    return row;
}

// ---------- input ----------

function cleanStrings(values, name) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new InputError(`${name} must be a list of strings.`);
    return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

function parseFilters(filters) {
    if (filters === undefined || filters === null) return [];
    if (!Array.isArray(filters)) throw new InputError('filters must be an array of {left, operation, right} objects.');
    return filters.map((f, i) => {
        if (!f || typeof f !== 'object' || Array.isArray(f)) throw new InputError(`filters[${i}] must be an object {left, operation, right}.`);
        const left = String(f.left ?? '').trim();
        const operation = String(f.operation ?? '').trim();
        if (!COLUMN_NAME.test(left)) throw new InputError(`filters[${i}].left must be a scanner field name such as "market_cap_basic" (got "${left}").`);
        if (!OPERATIONS.includes(operation)) throw new InputError(`filters[${i}].operation "${operation}" is not a scanner operation. Use one of: ${OPERATIONS.join(', ')}.`);
        if (NO_RIGHT_OPERATIONS.includes(operation)) return { left, operation };
        if (f.right === undefined || f.right === null) throw new InputError(`filters[${i}] (${left} ${operation}) needs a "right" value.`);
        if (ARRAY_RIGHT_OPERATIONS.includes(operation) && !Array.isArray(f.right)) throw new InputError(`filters[${i}] (${operation}) needs "right" as an array, e.g. [20, 30] or ["NASDAQ", "NYSE"].`);
        if (!ARRAY_RIGHT_OPERATIONS.includes(operation) && typeof f.right === 'object' && !Array.isArray(f.right)) throw new InputError(`filters[${i}] (${operation}) needs "right" as a number, string, boolean or array.`);
        return { left, operation, right: f.right };
    });
}

function normalizeSymbol(s) {
    const sym = s.trim().toUpperCase();
    if (!SYMBOL.test(sym)) throw new InputError(`symbol "${s}" must be EXCHANGE:TICKER, for example NASDAQ:AAPL, KRX:005930, BINANCE:BTCUSDT or FX:EURUSD.`);
    return sym;
}

// ---------- charging ----------

async function makeCharger() {
    let enabled = false;
    if (Actor.isAtHome()) {
        try {
            enabled = Boolean(Actor.getChargingManager().getPricingInfo().isPayPerEvent);
        } catch {
            enabled = false;
        }
    }
    if (!enabled) log.info('Pay-per-event charging is inactive (local run or non-PPE pricing); no events will be charged.');
    return {
        async charge(eventName, count = 1) {
            if (!enabled || count <= 0) return { allowed: count, limitReached: false };
            const result = await Actor.charge({ eventName, count });
            return { allowed: Math.min(count, result.chargedCount), limitReached: result.eventChargeLimitReached };
        },
    };
}

// ---------- main ----------

async function main() {
    const startedAt = Date.now();
    const input = (await Actor.getInput()) ?? {};

    const mode = String(input.mode ?? 'screener').trim().toLowerCase();
    if (!MODES.includes(mode)) throw new InputError(`mode must be one of ${MODES.join(', ')}.`);

    const presetName = String(input.preset ?? 'none').trim();
    const preset = presetName && presetName !== 'none' ? PRESETS[presetName] : null;
    if (presetName && presetName !== 'none' && !preset) throw new InputError(`preset "${presetName}" is unknown. Use one of: ${Object.keys(PRESETS).join(', ')}, or none.`);

    let market = String(input.market ?? '').trim().toLowerCase();
    if (!market) market = preset?.defaultMarket ?? 'america';
    if (!MARKETS.includes(market)) throw new InputError(`market "${market}" is not a scanner market. Use one of: ${MARKETS.join(', ')}.`);
    if (preset?.markets === 'stock' && !STOCK_MARKETS.includes(market)) throw new InputError(`preset ${presetName} applies to stock markets (america, korea, japan, germany ...), not "${market}".`);
    if (Array.isArray(preset?.markets) && !preset.markets.includes(market)) throw new InputError(`preset ${presetName} applies to market ${preset.markets.join(' or ')}, not "${market}".`);

    const requestedColumns = cleanStrings(input.columns, 'columns');
    let columns = requestedColumns.length ? requestedColumns : [...DEFAULT_COLUMNS];
    if (preset) columns = [...new Set([...columns, ...preset.columns])];
    for (const c of columns) if (!COLUMN_NAME.test(c)) throw new InputError(`column "${c}" is not a valid scanner field name (letters, digits, dot, underscore, pipe).`);
    if (columns.length > MAX_COLUMNS) throw new InputError(`columns: at most ${MAX_COLUMNS} per run (got ${columns.length}).`);

    const userFilters = parseFilters(input.filters);
    const filters = [...(preset?.filters ?? []), ...userFilters];
    const filter2 = input.filter2 ?? null;
    if (filter2 !== null && (typeof filter2 !== 'object' || Array.isArray(filter2))) throw new InputError('filter2 must be an object such as {"operator":"or","operands":[{"expression":{"left":"RSI","operation":"less","right":30}}]}.');

    const sortBy = String(input.sortBy ?? '').trim() || preset?.sort.sortBy || (STOCK_MARKETS.includes(market) ? 'market_cap_basic' : 'volume');
    if (!COLUMN_NAME.test(sortBy)) throw new InputError(`sortBy "${sortBy}" is not a valid scanner field name.`);
    let sortOrder = String(input.sortOrder ?? 'auto').trim().toLowerCase() || 'auto';
    if (!['auto', 'asc', 'desc'].includes(sortOrder)) throw new InputError('sortOrder must be "auto", "asc" or "desc".');
    if (sortOrder === 'auto') sortOrder = !String(input.sortBy ?? '').trim() && preset ? preset.sort.sortOrder : 'desc';

    const maxResults = input.maxResults ?? 500;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);

    const symbols = cleanStrings(input.symbols, 'symbols').map(normalizeSymbol);
    if (mode === 'snapshot' && symbols.length === 0) throw new InputError('snapshot mode needs at least one entry in symbols, for example ["NASDAQ:AAPL", "NYSE:IBM"].');
    if (mode !== 'snapshot' && symbols.length) log.warning(`symbols are only used in snapshot mode; ${symbols.length} entries ignored in ${mode} mode.`);
    if (mode === 'fields' && (filters.length || preset)) log.warning('filters and presets are ignored in fields mode.');

    const charger = await makeCharger();
    // The start fee is charged once the scanner has accepted the first request, so a request it rejects (400) costs nothing.
    let started = false;
    async function chargeStart() {
        if (started) return;
        started = true;
        if ((await charger.charge('actor-start', 1)).limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');
    }

    const stats = { mode, market, requests: 0, pages: 0, rowsPushed: 0, totalCount: null, missingSymbols: [], allNullColumns: [], fieldSource: null, fieldsListed: null, fieldsVerified: null, charged: {} };
    const notes = [];
    const nonNull = new Set();
    const track = (rows) => { for (const r of rows) for (const c of columns) if (r[c] !== null && r[c] !== undefined) nonNull.add(c); };
    let stopReason = null;

    async function pushCharged(rows, eventName) {
        await chargeStart();
        if (rows.length === 0 || stopReason) return;
        const { allowed, limitReached } = await charger.charge(eventName, rows.length);
        const slice = rows.slice(0, allowed);
        if (slice.length) {
            await Actor.pushData(slice);
            stats.rowsPushed += slice.length;
            stats.charged[eventName] = (stats.charged[eventName] || 0) + slice.length;
        }
        if (limitReached || allowed < rows.length) stopReason = `maximum charge reached (${eventName})`;
    }

    if (mode === 'screener') {
        let offset = 0;
        while (!stopReason && offset < maxResults) {
            const to = Math.min(offset + PAGE_SIZE, maxResults);
            const body = { columns, filter: filters, sort: { sortBy, sortOrder }, options: { lang: 'en' }, range: [offset, to] };
            if (filter2) body.filter2 = filter2;
            stats.requests++;
            stats.pages++;
            const { json } = await scannerRequest(`/${market}/scan`, body);
            if (json?.error) throw new InputError(`TradingView scanner error: ${json.error}`);
            const data = Array.isArray(json?.data) ? json.data : [];
            if (typeof json?.totalCount === 'number') stats.totalCount = json.totalCount;
            const asOf = new Date().toISOString();
            const rows = data.map((item) => toRow(item, columns, market, asOf));
            track(rows);
            await pushCharged(rows, 'screener-row');
            offset += data.length;
            log.info(`${market} page ${stats.pages}: ${data.length} rows, ${offset} so far (matching symbols: ${stats.totalCount ?? '?'})`);
            if (data.length < to - (offset - data.length)) break; // short page: no more rows
            if (stats.totalCount !== null && offset >= stats.totalCount) break;
        }
        if (!stopReason && stats.totalCount !== null && stats.totalCount > maxResults) stopReason = `maxResults (${maxResults}) reached; ${stats.totalCount} symbols match`;
        if (stats.totalCount === 0 && filters.length) notes.push('No symbol matched. The scanner answers an unknown field name in a filter with zero matches rather than an error; check the left-hand names with mode "fields".');
    } else if (mode === 'snapshot') {
        const wanted = symbols.slice(0, maxResults);
        const seen = new Set();
        for (let i = 0; i < wanted.length && !stopReason; i += SNAPSHOT_BATCH) {
            const batch = wanted.slice(i, i + SNAPSHOT_BATCH);
            stats.requests++;
            const { json } = await scannerRequest('/global/scan', { symbols: { tickers: batch, query: { types: [] } }, columns, options: { lang: 'en' } });
            if (json?.error) throw new InputError(`TradingView scanner error: ${json.error}`);
            const data = Array.isArray(json?.data) ? json.data : [];
            const asOf = new Date().toISOString();
            const rows = data.map((item) => toRow(item, columns, 'global', asOf)).filter((r) => !seen.has(r.symbol) && seen.add(r.symbol));
            track(rows);
            await pushCharged(rows, 'snapshot-row');
            log.info(`snapshot batch ${Math.floor(i / SNAPSHOT_BATCH) + 1}: ${rows.length} of ${batch.length} symbols returned`);
        }
        stats.missingSymbols = wanted.filter((s) => !seen.has(s));
        if (stats.missingSymbols.length) log.warning(`${stats.missingSymbols.length} symbols were not returned by the scanner (unknown or delisted): ${stats.missingSymbols.slice(0, 10).join(', ')}${stats.missingSymbols.length > 10 ? ' ...' : ''}`);
        if (symbols.length > maxResults) stopReason = `maxResults (${maxResults}) reached; ${symbols.length} symbols given`;
    } else {
        stats.requests++;
        const meta = await scannerRequest(`/${market}/metainfo`, null, { okStatuses: [404, 405] });
        await chargeStart();
        const asOf = new Date().toISOString();
        const blank = { values: null, valueCount: null, sampleValue: null, sampleSymbol: null, verified: null };
        let rows;
        if (meta.status === 200 && Array.isArray(meta.json?.fields)) {
            stats.fieldSource = 'metainfo';
            rows = meta.json.fields.map((f) => ({
                market, field: String(f.n), type: f.t ?? null, ...blank, values: Array.isArray(f.r) && f.r.length ? f.r.slice(0, 200) : null, valueCount: Array.isArray(f.r) ? f.r.length : null, source: 'metainfo', asOf,
            }));
            const have = new Set(rows.map((r) => r.field));
            for (const n of EXTRA_COLUMNS) if (!have.has(n)) rows.push({ market, field: n, type: 'text', ...blank, source: 'extra', asOf });
        } else {
            // No catalog for this market (global answers 405): probe the curated list and keep the names that return values.
            stats.fieldSource = 'scan-probe';
            rows = [...new Set([...KNOWN_COLUMNS, ...EXTRA_COLUMNS])].map((n) => ({ market, field: n, type: null, ...blank, source: 'scan-probe', asOf }));
        }
        // Verification: one scan of the most liquid symbols with every listed column. A field counts as verified when at
        // least one of them returns a value for it; the first non-null value is kept as the sample.
        stats.fieldsListed = rows.length;
        stats.requests++;
        const sortBy0 = STOCK_MARKETS.includes(market) || market === 'global' ? 'market_cap_basic' : 'volume';
        const { json } = await scannerRequest(`/${market}/scan`, { columns: rows.map((r) => r.field), range: [0, FIELD_SAMPLE_ROWS], sort: { sortBy: sortBy0, sortOrder: 'desc' }, options: { lang: 'en' } });
        const sample = Array.isArray(json?.data) ? json.data : [];
        rows.forEach((r, i) => {
            const hit = sample.find((it) => Array.isArray(it.d) && it.d[i] !== null && it.d[i] !== undefined);
            r.verified = sample.length ? Boolean(hit) : null;
            if (!hit) return;
            const v = hit.d[i];
            r.sampleValue = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}...` : (Array.isArray(v) && v.length > 50 ? v.slice(0, 50) : v);
            r.sampleSymbol = hit.s;
        });
        stats.fieldsVerified = rows.filter((r) => r.verified).length;
        if (stats.fieldSource === 'scan-probe') rows = rows.filter((r) => r.verified);
        rows.sort((a, b) => a.field.localeCompare(b.field));
        for (let i = 0; i < rows.length; i += 500) await Actor.pushData(rows.slice(i, i + 500));
        stats.rowsPushed = rows.length;
        log.info(`${rows.length} fields for ${market} from ${stats.fieldSource}`);
    }

    if (mode !== 'fields' && stats.rowsPushed > 0) {
        stats.allNullColumns = columns.filter((c) => !nonNull.has(c));
        if (stats.allNullColumns.length) notes.push(`Null in every returned row (unknown name for this market, or not applicable to these symbols): ${stats.allNullColumns.join(', ')}. The scanner answers unknown column names with null, not an error.`);
    }
    for (const n of notes) log.warning(n);
    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        disclaimer: 'Descriptive market data from TradingView\'s public scanner endpoint. Column values are as the scanner reports them; nothing here is a recommendation.',
        request: { mode, market: mode === 'snapshot' ? 'global' : market, columns, filters, filter2, sort: { sortBy, sortOrder }, maxResults, preset: preset ? presetName : null, presetDefinition: preset ?? null, symbols: symbols.length },
        stats,
        notes,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.rowsPushed} rows, ${stats.requests} requests; ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.rowsPushed} rows (${mode}, ${summary.request.market}); ${summary.stopReason}`);
}

await Actor.main(async () => {
    try {
        await main();
    } finally {
        // Let keep-alive sockets from the last fetch settle before the SDK exits the process; without this,
        // Node 24 on Windows can abort with a libuv assertion instead of the intended exit code.
        await sleep(300);
    }
});
