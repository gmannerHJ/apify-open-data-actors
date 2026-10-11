import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const RSS_NEWS = 'https://feeds.finance.yahoo.com/rss/2.0/headline';
const MIN_GAP_MS = 200; // five requests per second across the run
const CONCURRENCY = 2; // symbols in flight
const REQUEST_TIMEOUT_MS = 30000;
const MAX_SYMBOLS = 500;
const MAX_RESULTS_CAP = 100000;
const QUOTE_BATCH = 50; // symbols per v7/quote call
const HISTORY_BLOCK = 100; // rows per history-100bars event
const MODES = ['quotes', 'history', 'fundamentals', 'options', 'search', 'news'];
const INTERVALS = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'];
const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'];
const RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731, '5y': 1827, '10y': 3653 };
const ONE_MINUTE_WINDOW_DAYS = 7; // Yahoo serves at most 7 days of 1m bars per request
const ONE_MINUTE_HISTORY_DAYS = 30;
const MODULES = ['summaryDetail', 'price', 'quoteType', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'summaryProfile', 'calendarEvents', 'earnings', 'earningsHistory', 'earningsTrend', 'recommendationTrend', 'upgradeDowngradeHistory', 'incomeStatementHistory', 'incomeStatementHistoryQuarterly', 'balanceSheetHistory', 'balanceSheetHistoryQuarterly', 'cashflowStatementHistory', 'cashflowStatementHistoryQuarterly', 'majorHoldersBreakdown', 'institutionOwnership', 'fundOwnership', 'insiderHolders', 'insiderTransactions', 'netSharePurchaseActivity', 'secFilings', 'esgScores', 'indexTrend', 'industryTrend', 'sectorTrend', 'fundProfile', 'topHoldings', 'fundPerformance'];
const DEFAULT_MODULES = ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'assetProfile', 'calendarEvents', 'recommendationTrend', 'earnings'];
const FALLBACK_RISK_FREE = 0.045;

class InputError extends Error {}
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (epochSec) => (typeof epochSec === 'number' && Number.isFinite(epochSec) && epochSec > 0 ? new Date(epochSec * 1000).toISOString() : null);
const round = (n, d = 6) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);

// ---------- pacing ----------

let lastRequestAt = 0;
let paceChain = Promise.resolve();
function pace() {
    const next = paceChain.then(async () => {
        const wait = lastRequestAt + MIN_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    paceChain = next.catch(() => {});
    return next;
}

async function timedFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
        throw e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : e;
    } finally {
        clearTimeout(timer);
    }
}

// ---------- Yahoo session: cookie + crumb ----------

class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    absorb(res) {
        const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const c of list) {
            const pair = c.split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }

    header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    get size() {
        return this.cookies.size;
    }
}

class YahooSession {
    constructor(stats) {
        this.stats = stats;
        this.jar = new CookieJar();
        this.crumb = null;
        this.strategy = null;
        this.refreshes = 0;
        this.establishing = null;
        this.lastError = null;
    }

    async ensure() {
        if (this.crumb) return;
        if (!this.establishing) this.establishing = this.establish().finally(() => { this.establishing = null; });
        await this.establishing;
    }

    async refresh() {
        this.refreshes++;
        this.crumb = null;
        await this.ensure();
    }

    async establish() {
        const errors = [];
        for (const [name, fn] of [['cookie', () => this.basic()], ['consent', () => this.consent()]]) {
            try {
                await fn();
                if (this.crumb) {
                    this.strategy = name;
                    log.info(`Yahoo session ready (${name} strategy, ${this.jar.size} cookies)`);
                    return;
                }
                errors.push(`${name}: no crumb returned`);
            } catch (e) {
                errors.push(`${name}: ${e.message}`);
            }
        }
        this.lastError = errors.join(' | ');
        throw new Error(`Could not obtain a Yahoo crumb (${this.lastError})`);
    }

    // Follows redirects by hand so cookies set along the way are kept.
    async follow(url, { method = 'GET', body, headers = {} } = {}) {
        let current = url;
        let m = method;
        let b = body;
        for (let hop = 0; hop < 10; hop++) {
            await pace();
            this.stats.requests++;
            const res = await timedFetch(current, { method: m, body: b, redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', cookie: this.jar.header(), ...headers } });
            this.jar.absorb(res);
            if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
                await res.body?.cancel().catch(() => {});
                current = new URL(res.headers.get('location'), current).toString();
                if (res.status !== 307 && res.status !== 308) {
                    m = 'GET';
                    b = undefined;
                }
                continue;
            }
            return { res, url: current, text: await res.text() };
        }
        throw new Error('too many redirects');
    }

    async getCrumb() {
        for (const host of HOSTS) {
            await pace();
            this.stats.requests++;
            const res = await timedFetch(`${host}/v1/test/getcrumb`, { headers: { 'user-agent': UA, accept: 'text/plain,*/*', cookie: this.jar.header() } });
            const text = (await res.text()).trim();
            if (res.status === 200 && text && text.length < 64 && !text.includes('<')) return text;
            if (res.status === 429) await sleep(5000);
        }
        return null;
    }

    async basic() {
        this.jar = new CookieJar();
        const { url } = await this.follow('https://fc.yahoo.com/');
        if (/consent\.yahoo\.com|guce\.yahoo\.com/.test(url)) throw new Error('redirected to the consent page (EU host)');
        if (this.jar.size === 0) throw new Error('fc.yahoo.com set no cookie');
        this.crumb = await this.getCrumb();
    }

    async consent() {
        this.jar = new CookieJar();
        const first = await this.follow('https://guce.yahoo.com/consent');
        const sessionId = new URL(first.url).searchParams.get('sessionId');
        const csrfToken = /name="csrfToken"\s+value="([^"]+)"/.exec(first.text)?.[1];
        if (!sessionId || !csrfToken) throw new Error(`consent page without sessionId/csrfToken (final URL ${first.url.slice(0, 80)})`);
        const form = new URLSearchParams([['agree', 'agree'], ['agree', 'agree'], ['consentUUID', 'default'], ['sessionId', sessionId], ['csrfToken', csrfToken], ['originalDoneUrl', 'https://finance.yahoo.com/'], ['namespace', 'yahoo']]);
        await this.follow(`https://consent.yahoo.com/v2/collectConsent?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        await this.follow(`https://guce.yahoo.com/copyConsent?sessionId=${encodeURIComponent(sessionId)}&${form.toString()}`);
        if (this.jar.size === 0) throw new Error('consent flow set no cookie');
        this.crumb = await this.getCrumb();
    }
}

// ---------- JSON API ----------

function errorDescription(text) {
    try {
        const j = JSON.parse(text);
        for (const k of ['chart', 'quoteSummary', 'optionChain', 'quoteResponse', 'finance']) {
            const d = j?.[k]?.error?.description || j?.[k]?.error?.code;
            if (d) return d;
        }
    } catch { /* not JSON */ }
    return text.replace(/\s+/g, ' ').slice(0, 160);
}

async function apiJson(session, path, params = {}, { needsCrumb = false, attempts = 4, label = path } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const host = HOSTS[(attempt - 1) % HOSTS.length];
        if (needsCrumb) await session.ensure();
        const u = new URL(host + path);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
        if (needsCrumb) u.searchParams.set('crumb', session.crumb);
        await pace();
        session.stats.requests++;
        let res;
        let text;
        try {
            res = await timedFetch(u, { headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', 'accept-language': 'en-US,en;q=0.9', ...(session.jar.size ? { cookie: session.jar.header() } : {}) } });
            text = await res.text();
        } catch (e) {
            lastError = e;
            if (attempt < attempts) await sleep(1000 * attempt);
            continue;
        }
        if (res.status === 200) {
            try {
                return JSON.parse(text);
            } catch {
                throw new ApiError(200, `${label}: response is not JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`);
            }
        }
        if ((res.status === 401 || res.status === 403) && needsCrumb && session.refreshes < 3) {
            log.warning(`${label}: HTTP ${res.status} (${errorDescription(text)}); refreshing the Yahoo session`);
            session.stats.sessionRefreshes++;
            await session.refresh();
            continue;
        }
        if (res.status === 429 || res.status >= 500) {
            lastError = new ApiError(res.status, `HTTP ${res.status}`);
            if (attempt < attempts) {
                const retryAfter = Number(res.headers.get('retry-after'));
                const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 5000 : 1500) * 2 ** (attempt - 1);
                log.warning(`${label}: HTTP ${res.status} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                await sleep(delay);
            }
            continue;
        }
        throw new ApiError(res.status, `HTTP ${res.status}: ${errorDescription(text)}`);
    }
    throw new ApiError(lastError?.status ?? 0, `${label}: ${lastError?.message || 'request failed'} (after ${attempts} attempts)`);
}

// ---------- normalisation ----------

// quoteSummary values come as {raw, fmt, longFmt}; keep the raw number, drop formatting and maxAge.
function plain(v) {
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        if (keys.length === 0) return null;
        if ('raw' in v) return v.raw;
        if (keys.every((k) => k === 'fmt' || k === 'longFmt')) return v.fmt ?? null;
        const o = {};
        for (const [k, x] of Object.entries(v)) {
            if (k === 'maxAge') continue;
            o[k] = plain(x);
        }
        return o;
    }
    return v;
}

function parseDateInput(value, name) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const s = String(value).trim();
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    if (Number.isNaN(d.getTime())) throw new InputError(`${name} "${value}" is not a date (YYYY-MM-DD or ISO datetime).`);
    return d;
}

function localDate(epochSec, gmtOffsetSec) {
    return new Date((epochSec + (gmtOffsetSec || 0)) * 1000).toISOString().slice(0, 10);
}

// ---------- Black-Scholes ----------

function normCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-z * z);
    return 0.5 * (1 + (z < 0 ? -erf : erf));
}
const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

function greeks({ type, S, K, T, r, sigma }) {
    if (!(S > 0 && K > 0 && T > 0 && sigma > 1e-4)) return null;
    const sqT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqT);
    const d2 = d1 - sigma * sqT;
    const disc = Math.exp(-r * T);
    const call = type === 'call';
    const delta = call ? normCdf(d1) : normCdf(d1) - 1;
    const gamma = normPdf(d1) / (S * sigma * sqT);
    const vega = S * normPdf(d1) * sqT / 100;
    const thetaYear = -(S * normPdf(d1) * sigma) / (2 * sqT) - (call ? r * K * disc * normCdf(d2) : -r * K * disc * normCdf(-d2));
    const rho = (call ? K * T * disc * normCdf(d2) : -K * T * disc * normCdf(-d2)) / 100;
    return { delta: round(delta), gamma: round(gamma), theta: round(thetaYear / 365), vega: round(vega), rho: round(rho) };
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
        enabled,
        async charge(eventName, count) {
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
    const mode = String(input.mode ?? 'quotes');
    if (!MODES.includes(mode)) throw new InputError(`mode must be one of ${MODES.join(', ')}.`);
    const clean = (values, name) => {
        if (values === undefined || values === null) return [];
        if (!Array.isArray(values)) throw new InputError(`${name} must be a list of strings.`);
        return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))];
    };
    const symbols = clean(input.symbols, 'symbols').map((s) => s.toUpperCase());
    const queries = clean(input.queries, 'queries');
    if (mode === 'search') {
        if (queries.length === 0) throw new InputError('search mode needs at least one entry in queries.');
    } else if (symbols.length === 0) throw new InputError(`${mode} mode needs at least one entry in symbols (AAPL, 005930.KS, BTC-USD ...).`);
    if (symbols.length > MAX_SYMBOLS) throw new InputError(`At most ${MAX_SYMBOLS} symbols per run (got ${symbols.length}).`);
    for (const s of symbols) if (!/^[A-Z0-9^.=\-&]{1,20}$/.test(s)) throw new InputError(`"${s}" is not a Yahoo Finance symbol.`);
    const interval = String(input.interval ?? '1d');
    if (!INTERVALS.includes(interval)) throw new InputError(`interval must be one of ${INTERVALS.join(', ')}.`);
    const range = String(input.range ?? '1mo');
    if (!RANGES.includes(range)) throw new InputError(`range must be one of ${RANGES.join(', ')}.`);
    const startDate = parseDateInput(input.startDate, 'startDate');
    const endDate = parseDateInput(input.endDate, 'endDate');
    if (startDate && endDate && endDate <= startDate) throw new InputError('endDate must be after startDate.');
    const adjusted = input.adjusted !== false;
    const includeEvents = input.includeEvents !== false;
    const includePrePost = Boolean(input.includePrePost);
    const modules = clean(input.modules, 'modules');
    const useModules = modules.length ? modules : DEFAULT_MODULES;
    for (const m of useModules) if (!MODULES.includes(m)) throw new InputError(`modules entry "${m}" is not a quoteSummary module. Valid: ${MODULES.join(', ')}.`);
    const optionsExpirations = input.optionsExpirations ?? 1;
    if (!Number.isInteger(optionsExpirations) || optionsExpirations < 1 || optionsExpirations > 40) throw new InputError('optionsExpirations must be an integer between 1 and 40.');
    const optionsExpirationDates = clean(input.optionsExpirationDates, 'optionsExpirationDates');
    for (const d of optionsExpirationDates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new InputError(`optionsExpirationDates entry "${d}" must be YYYY-MM-DD.`);
    const includeGreeks = input.includeGreeks !== false;
    const maxResults = input.maxResults ?? 10000;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);
    const region = String(input.region ?? 'US').trim().toUpperCase();
    const lang = String(input.lang ?? 'en-US').trim();
    if (!/^[A-Z]{2}$/.test(region)) throw new InputError('region must be a two-letter code such as US, GB, DE, JP.');
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new InputError('lang must be a code such as en-US, de-DE, ja-JP.');

    const charger = await makeCharger();
    if ((await charger.charge('actor-start', 1)).limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    const stats = { mode, requests: 0, sessionRefreshes: 0, symbols: symbols.length, queries: queries.length, tasksOk: 0, tasksFailed: 0, rowsPushed: 0, rowsByType: {}, charged: {}, blockedEndpoints: [] };
    const failures = [];
    const session = new YahooSession(stats);
    const fetchedAt = new Date().toISOString();
    let stopReason = null;
    log.info(`Starting ${mode}: ${mode === 'search' ? `${queries.length} queries` : `${symbols.length} symbols`}, region ${region}, lang ${lang}`);

    const needsCrumb = ['quotes', 'fundamentals', 'options'].includes(mode);
    if (needsCrumb) {
        try {
            await session.ensure();
        } catch (e) {
            log.warning(`${e.message}. Endpoints needing a crumb (quote, quoteSummary, options) may fail; quotes fall back to chart metadata.`);
            stats.blockedEndpoints.push({ endpoint: 'v1/test/getcrumb', error: e.message });
        }
    }

    // Serialised push with charging; returns false when the charge limit stops the run.
    let pushChain = Promise.resolve();
    function emit(rows, eventName, eventCount = rows.length, rowsPerEvent = 1) {
        const p = pushChain.then(async () => {
            if (stopReason || rows.length === 0) return;
            const { allowed, limitReached } = await charger.charge(eventName, eventCount);
            const keep = rows.slice(0, Math.min(rows.length, allowed * rowsPerEvent));
            if (keep.length) {
                await Actor.pushData(keep);
                stats.rowsPushed += keep.length;
                for (const r of keep) stats.rowsByType[r.recordType] = (stats.rowsByType[r.recordType] || 0) + 1;
                stats.charged[eventName] = (stats.charged[eventName] || 0) + Math.min(eventCount, allowed);
            }
            if (limitReached || allowed < eventCount) stopReason = `maximum charge reached (${eventName})`;
        });
        pushChain = p.catch((e) => log.exception(e, 'push failed'));
        return p;
    }

    const noteBlocked = (endpoint, e) => {
        if (e instanceof ApiError && [401, 403, 429].includes(e.status) && !stats.blockedEndpoints.some((b) => b.endpoint === endpoint)) stats.blockedEndpoints.push({ endpoint, status: e.status, error: e.message });
    };

    // ----- quotes -----
    function quoteRow(q, source) {
        return {
            recordType: 'quote',
            symbol: q.symbol,
            asOf: iso(q.regularMarketTime),
            currency: q.currency ?? null,
            exchange: q.exchange ?? null,
            ...q,
            source,
            fetchedAt,
        };
    }

    async function quoteFromChart(symbol) {
        const j = await apiJson(session, `/v8/finance/chart/${encodeURIComponent(symbol)}`, { range: '1d', interval: '1d', region, lang }, { label: `chart ${symbol}` });
        const r = j?.chart?.result?.[0];
        if (!r) throw new ApiError(404, j?.chart?.error?.description || 'no chart result');
        const m = r.meta || {};
        const close = r.indicators?.quote?.[0]?.close?.filter((x) => typeof x === 'number');
        const prev = m.chartPreviousClose ?? m.previousClose ?? null;
        const price = m.regularMarketPrice ?? (close?.length ? close[close.length - 1] : null);
        return quoteRow({
            symbol: m.symbol || symbol,
            currency: m.currency,
            exchange: m.exchangeName,
            fullExchangeName: m.fullExchangeName,
            quoteType: m.instrumentType,
            shortName: m.shortName,
            longName: m.longName,
            exchangeTimezoneName: m.exchangeTimezoneName,
            regularMarketTime: m.regularMarketTime,
            regularMarketPrice: price,
            regularMarketPreviousClose: prev,
            regularMarketChange: typeof price === 'number' && typeof prev === 'number' ? round(price - prev, 6) : null,
            regularMarketChangePercent: typeof price === 'number' && typeof prev === 'number' && prev ? round((price / prev - 1) * 100, 4) : null,
            regularMarketDayHigh: m.regularMarketDayHigh ?? null,
            regularMarketDayLow: m.regularMarketDayLow ?? null,
            regularMarketVolume: m.regularMarketVolume ?? null,
            fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
            firstTradeDateMilliseconds: typeof m.firstTradeDate === 'number' ? m.firstTradeDate * 1000 : null,
        }, 'chart');
    }

    async function runQuotes() {
        for (let i = 0; i < symbols.length && !stopReason; i += QUOTE_BATCH) {
            const chunk = symbols.slice(i, i + QUOTE_BATCH);
            let rows = [];
            let missing = chunk;
            if (session.crumb) {
                try {
                    const j = await apiJson(session, '/v7/finance/quote', { symbols: chunk.join(','), region, lang }, { needsCrumb: true, label: 'quote' });
                    rows = (j?.quoteResponse?.result || []).map((q) => quoteRow(q, 'quote'));
                    const got = new Set(rows.map((r) => r.symbol.toUpperCase()));
                    missing = chunk.filter((s) => !got.has(s));
                } catch (e) {
                    noteBlocked('v7/finance/quote', e);
                    log.warning(`quote batch failed (${e.message}); falling back to chart metadata per symbol`);
                }
            }
            for (const s of missing) {
                try {
                    rows.push(await quoteFromChart(s));
                } catch (e) {
                    stats.tasksFailed++;
                    failures.push({ symbol: s, error: e.message });
                    log.warning(`${s}: ${e.message}`);
                }
            }
            stats.tasksOk += rows.length;
            await emit(rows, 'quote-row');
        }
    }

    // ----- history -----
    function historyWindow() {
        const now = Math.floor(Date.now() / 1000);
        if (startDate) return { period1: Math.floor(startDate.getTime() / 1000), period2: endDate ? Math.floor(endDate.getTime() / 1000) : now };
        if (range === 'ytd') return { period1: Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000), period2: now };
        if (range === 'max') return { period1: 0, period2: now };
        return { period1: now - RANGE_DAYS[range] * 86400, period2: now };
    }

    async function fetchChart(symbol, params) {
        const j = await apiJson(session, `/v8/finance/chart/${encodeURIComponent(symbol)}`, { ...params, region, lang }, { label: `chart ${symbol}` });
        const r = j?.chart?.result?.[0];
        if (!r) throw new ApiError(404, j?.chart?.error?.description || 'no chart result');
        return r;
    }

    async function runHistory(symbol) {
        const base = { interval, includeAdjustedClose: adjusted ? 'true' : 'false', includePrePost: includePrePost ? 'true' : 'false', events: includeEvents ? 'div,splits,capitalGains' : '' };
        const results = [];
        if (interval === '1m') {
            let { period1, period2 } = historyWindow();
            period1 = Math.max(period1, period2 - ONE_MINUTE_HISTORY_DAYS * 86400);
            for (let p1 = period1; p1 < period2; p1 += ONE_MINUTE_WINDOW_DAYS * 86400) {
                results.push(await fetchChart(symbol, { ...base, period1: p1, period2: Math.min(period2, p1 + ONE_MINUTE_WINDOW_DAYS * 86400) }));
            }
        } else if (startDate || range === 'ytd') {
            results.push(await fetchChart(symbol, { ...base, ...historyWindow() }));
        } else {
            results.push(await fetchChart(symbol, { ...base, range }));
        }
        const meta = results[0].meta || {};
        const common = { symbol: meta.symbol || symbol, currency: meta.currency ?? null, exchange: meta.exchangeName ?? null, interval, fetchedAt };
        const rows = [];
        const seen = new Set();
        for (const r of results) {
            const ts = r.timestamp || [];
            const q = r.indicators?.quote?.[0] || {};
            const adj = r.indicators?.adjclose?.[0]?.adjclose || [];
            const off = r.meta?.gmtoffset ?? meta.gmtoffset ?? 0;
            for (let i = 0; i < ts.length; i++) {
                const close = q.close?.[i];
                if (typeof close !== 'number' || seen.has(ts[i])) continue;
                seen.add(ts[i]);
                const row = { recordType: 'bar', ...common, asOf: iso(ts[i]), date: localDate(ts[i], off), open: q.open?.[i] ?? null, high: q.high?.[i] ?? null, low: q.low?.[i] ?? null, close, volume: q.volume?.[i] ?? null };
                if (adjusted) {
                    const a = adj[i];
                    row.adjClose = typeof a === 'number' ? a : null;
                    const f = typeof a === 'number' && close ? a / close : null;
                    row.adjOpen = f !== null && typeof row.open === 'number' ? round(row.open * f, 6) : null;
                    row.adjHigh = f !== null && typeof row.high === 'number' ? round(row.high * f, 6) : null;
                    row.adjLow = f !== null && typeof row.low === 'number' ? round(row.low * f, 6) : null;
                }
                rows.push(row);
            }
            if (includeEvents && r.events) {
                for (const [t, e] of Object.entries(r.events.dividends || {})) if (!seen.has(`d${t}`)) { seen.add(`d${t}`); rows.push({ recordType: 'dividend', ...common, asOf: iso(e.date ?? Number(t)), date: localDate(e.date ?? Number(t), off), amount: e.amount ?? null }); }
                for (const [t, e] of Object.entries(r.events.splits || {})) if (!seen.has(`s${t}`)) { seen.add(`s${t}`); rows.push({ recordType: 'split', ...common, asOf: iso(e.date ?? Number(t)), date: localDate(e.date ?? Number(t), off), numerator: e.numerator ?? null, denominator: e.denominator ?? null, splitRatio: e.splitRatio ?? null }); }
                for (const [t, e] of Object.entries(r.events.capitalGains || {})) if (!seen.has(`c${t}`)) { seen.add(`c${t}`); rows.push({ recordType: 'capitalGain', ...common, asOf: iso(e.date ?? Number(t)), date: localDate(e.date ?? Number(t), off), amount: e.amount ?? null }); }
            }
        }
        rows.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
        const kept = rows.length > maxResults ? rows.slice(rows.length - maxResults) : rows;
        log.info(`${symbol}: ${kept.length} history rows (${interval}, ${results.length} request${results.length > 1 ? 's' : ''})`);
        await emit(kept, 'history-100bars', Math.ceil(kept.length / HISTORY_BLOCK), HISTORY_BLOCK);
    }

    // ----- fundamentals -----
    async function runFundamentals(symbol) {
        const request = [...new Set([...useModules, 'price'])];
        const j = await apiJson(session, `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`, { modules: request.join(','), region, lang }, { needsCrumb: true, label: `quoteSummary ${symbol}` });
        const r = j?.quoteSummary?.result?.[0];
        if (!r) throw new ApiError(404, j?.quoteSummary?.error?.description || 'no quoteSummary result');
        const price = r.price || {};
        const rows = [];
        for (const m of useModules) {
            if (!r[m] || (typeof r[m] === 'object' && Object.keys(r[m]).filter((k) => k !== 'maxAge').length === 0)) {
                failures.push({ symbol, module: m, error: 'module not available for this symbol' });
                continue;
            }
            rows.push({ recordType: 'fundamentals', symbol, module: m, asOf: fetchedAt, currency: price.currency ?? null, exchange: price.exchange ?? null, quoteType: price.quoteType ?? null, data: plain(r[m]), fetchedAt });
        }
        log.info(`${symbol}: ${rows.length}/${useModules.length} modules`);
        await emit(rows, 'fundamentals-module');
    }

    // ----- options -----
    let riskFree = null;
    async function getRiskFree() {
        if (riskFree !== null) return riskFree;
        try {
            const r = await fetchChart('^IRX', { range: '5d', interval: '1d' });
            const p = r.meta?.regularMarketPrice;
            riskFree = typeof p === 'number' && p > 0 && p < 30 ? round(p / 100, 6) : FALLBACK_RISK_FREE;
        } catch {
            riskFree = FALLBACK_RISK_FREE;
        }
        return riskFree;
    }

    async function runOptions(symbol) {
        const first = await apiJson(session, `/v7/finance/options/${encodeURIComponent(symbol)}`, { region, lang }, { needsCrumb: true, label: `options ${symbol}` });
        const r0 = first?.optionChain?.result?.[0];
        if (!r0) throw new ApiError(404, first?.optionChain?.error?.description || 'no option chain');
        const available = r0.expirationDates || [];
        if (available.length === 0) throw new ApiError(404, 'no listed options for this symbol');
        let wanted;
        if (optionsExpirationDates.length) {
            wanted = [];
            for (const d of optionsExpirationDates) {
                const epoch = Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
                if (available.includes(epoch)) wanted.push(epoch);
                else failures.push({ symbol, expiration: d, error: 'expiration not listed by Yahoo' });
            }
        } else wanted = available.slice(0, optionsExpirations);
        const rf = includeGreeks ? await getRiskFree() : null;
        const quote = r0.quote || {};
        const S = quote.regularMarketPrice ?? null;
        const nowSec = Date.now() / 1000;
        const rows = [];
        for (const exp of wanted) {
            let chain = r0.options?.[0]?.expirationDate === exp ? r0.options[0] : null;
            if (!chain) {
                const j = await apiJson(session, `/v7/finance/options/${encodeURIComponent(symbol)}`, { date: exp, region, lang }, { needsCrumb: true, label: `options ${symbol} ${exp}` });
                chain = j?.optionChain?.result?.[0]?.options?.[0];
            }
            if (!chain) {
                failures.push({ symbol, expiration: iso(exp)?.slice(0, 10), error: 'empty chain' });
                continue;
            }
            const T = Math.max(exp + 20.5 * 3600 - nowSec, 3600) / (365.25 * 86400);
            for (const [type, list] of [['call', chain.calls || []], ['put', chain.puts || []]]) {
                for (const c of list) {
                    const bid = c.bid ?? null;
                    const ask = c.ask ?? null;
                    const row = {
                        recordType: 'option',
                        symbol,
                        contractSymbol: c.contractSymbol,
                        optionType: type,
                        expiration: iso(c.expiration ?? exp)?.slice(0, 10) ?? null,
                        daysToExpiration: round(((c.expiration ?? exp) - nowSec) / 86400, 2),
                        asOf: iso(c.lastTradeDate),
                        currency: c.currency ?? quote.currency ?? null,
                        exchange: quote.exchange ?? null,
                        strike: c.strike ?? null,
                        lastPrice: c.lastPrice ?? null,
                        bid,
                        ask,
                        mid: typeof bid === 'number' && typeof ask === 'number' && ask > 0 ? round((bid + ask) / 2, 4) : null,
                        change: c.change ?? null,
                        percentChange: c.percentChange ?? null,
                        volume: c.volume ?? null,
                        openInterest: c.openInterest ?? null,
                        impliedVolatility: c.impliedVolatility ?? null,
                        inTheMoney: c.inTheMoney ?? null,
                        contractSize: c.contractSize ?? null,
                        underlyingPrice: S,
                        underlyingName: quote.shortName ?? null,
                        delta: null,
                        gamma: null,
                        theta: null,
                        vega: null,
                        rho: null,
                        riskFreeRate: rf,
                        fetchedAt,
                    };
                    if (includeGreeks) Object.assign(row, greeks({ type, S, K: c.strike, T, r: rf, sigma: c.impliedVolatility }) || {});
                    rows.push(row);
                }
            }
        }
        const kept = rows.slice(0, maxResults);
        log.info(`${symbol}: ${kept.length} contracts across ${wanted.length} expiration${wanted.length === 1 ? '' : 's'}`);
        await emit(kept, 'options-row');
    }

    // ----- search -----
    async function runSearch(query) {
        const j = await apiJson(session, '/v1/finance/search', { q: query, quotesCount: Math.min(maxResults, 50), newsCount: 0, listsCount: 0, enableFuzzyQuery: 'false', region, lang }, { label: `search "${query}"` });
        const rows = (j?.quotes || []).slice(0, maxResults).map((q) => ({
            recordType: 'search',
            query,
            symbol: q.symbol ?? null,
            asOf: fetchedAt,
            currency: null,
            exchange: q.exchange ?? null,
            exchangeDisplay: q.exchDisp ?? null,
            shortName: q.shortname ?? null,
            longName: q.longname ?? null,
            quoteType: q.quoteType ?? null,
            typeDisplay: q.typeDisp ?? null,
            sector: q.sector ?? null,
            industry: q.industry ?? null,
            score: q.score ?? null,
            isYahooFinance: q.isYahooFinance ?? null,
            fetchedAt,
        }));
        log.info(`search "${query}": ${rows.length} matches`);
        await emit(rows, 'search-row');
    }

    // ----- news -----
    const decodeEntities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    const tagText = (xml, name) => {
        const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
        if (!m) return null;
        const v = m[1].trim();
        const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
        return decodeEntities(cdata ? cdata[1] : v).trim();
    };

    async function newsFromRss(symbol) {
        await pace();
        stats.requests++;
        const res = await timedFetch(`${RSS_NEWS}?s=${encodeURIComponent(symbol)}&region=${encodeURIComponent(region)}&lang=${encodeURIComponent(lang)}`, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } });
        const xml = await res.text();
        if (res.status !== 200) throw new ApiError(res.status, `news RSS HTTP ${res.status}`);
        const rows = [];
        const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
        let m;
        while ((m = re.exec(xml))) {
            const it = m[1];
            const pub = tagText(it, 'pubDate');
            const d = pub ? new Date(pub) : null;
            rows.push({ uuid: tagText(it, 'guid'), title: tagText(it, 'title'), publisher: null, url: tagText(it, 'link'), publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null, type: null, thumbnailUrl: null, relatedTickers: [symbol], summary: tagText(it, 'description'), source: 'rss' });
        }
        return rows;
    }

    async function runNews(symbol) {
        let items = [];
        try {
            const j = await apiJson(session, '/v1/finance/search', { q: symbol, quotesCount: 0, newsCount: Math.min(maxResults, 50), listsCount: 0, region, lang }, { label: `news ${symbol}` });
            items = (j?.news || []).map((n) => ({
                uuid: n.uuid ?? null,
                title: n.title ?? null,
                publisher: n.publisher ?? null,
                url: n.link ?? null,
                publishedAt: iso(n.providerPublishTime),
                type: n.type ?? null,
                thumbnailUrl: (n.thumbnail?.resolutions || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ?? null,
                relatedTickers: n.relatedTickers ?? [],
                summary: null,
                source: 'search',
            }));
        } catch (e) {
            noteBlocked('v1/finance/search', e);
            log.warning(`${symbol}: news search failed (${e.message}); trying the RSS feed`);
        }
        if (items.length === 0) items = await newsFromRss(symbol);
        const seen = new Set();
        const rows = [];
        for (const n of items) {
            const key = n.url || n.uuid || n.title;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            rows.push({ recordType: 'news', symbol, asOf: n.publishedAt, currency: null, exchange: null, ...n, fetchedAt });
            if (rows.length >= maxResults) break;
        }
        log.info(`${symbol}: ${rows.length} news items (${rows[0]?.source || 'none'})`);
        await emit(rows, 'news-row');
    }

    // ----- dispatcher -----
    const tasks = mode === 'search' ? queries : symbols;
    const runner = { history: runHistory, fundamentals: runFundamentals, options: runOptions, search: runSearch, news: runNews }[mode];
    if (mode === 'quotes') {
        await runQuotes();
    } else {
        let i = 0;
        const workers = Array.from({ length: CONCURRENCY }, async () => {
            while (i < tasks.length && !stopReason) {
                const t = tasks[i++];
                try {
                    await runner(t);
                    stats.tasksOk++;
                } catch (e) {
                    stats.tasksFailed++;
                    noteBlocked(`${mode} endpoint`, e);
                    failures.push({ [mode === 'search' ? 'query' : 'symbol']: t, error: e.message });
                    log.warning(`${t}: ${e.message}`);
                }
            }
        });
        await Promise.all(workers);
    }
    await pushChain;

    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        input: { mode, symbols: symbols.length, queries, interval, range, startDate: startDate?.toISOString() ?? null, endDate: endDate?.toISOString() ?? null, adjusted, includeEvents, includePrePost, modules: mode === 'fundamentals' ? useModules : undefined, optionsExpirations, optionsExpirationDates, includeGreeks, riskFreeRate: riskFree, maxResults, region, lang },
        session: { strategy: session.strategy, crumbObtained: Boolean(session.crumb), refreshes: session.refreshes, error: session.lastError },
        stats,
        failures,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.rowsPushed} rows (${JSON.stringify(stats.rowsByType)}), ${stats.requests} requests, ${stats.tasksFailed} failures; ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.rowsPushed} rows (${mode}), ${stats.tasksFailed} failures`);
    if (stats.rowsPushed === 0 && stats.tasksFailed > 0) throw new Error(`Nothing could be fetched: ${failures.map((f) => f.error).slice(0, 3).join('; ')}`);
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
