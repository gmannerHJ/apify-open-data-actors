// Local end-to-end test against the live TradingView scanner using the SDK's local storage (no Apify account needed).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const actorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageDir = path.join(actorDir, 'storage');
const results = [];
let failures = 0;

function assert(cond, msg) {
    if (!cond) {
        failures++;
        console.error(`  ASSERTION FAILED: ${msg}`);
    }
}

function readDataset() {
    const dir = path.join(storageDir, 'datasets', 'default');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
}

function readSummary() {
    const p = path.join(storageDir, 'key_value_stores', 'default', 'SUMMARY.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

async function runActor(name, input) {
    rmSync(storageDir, { recursive: true, force: true });
    const kv = path.join(storageDir, 'key_value_stores', 'default');
    mkdirSync(kv, { recursive: true });
    writeFileSync(path.join(kv, 'INPUT.json'), JSON.stringify(input, null, 2));
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['src/main.js'], {
            cwd: actorDir,
            env: { ...process.env, APIFY_LOCAL_STORAGE_DIR: storageDir, CRAWLEE_STORAGE_DIR: storageDir, APIFY_LOG_LEVEL: 'INFO' },
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.on('close', resolve);
    });
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    const rows = readDataset();
    const summary = readSummary();
    results.push({ name, exitCode: code, rows: rows.length, secs, requests: summary?.stats?.requests, totalCount: summary?.stats?.totalCount, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, requests=${summary?.stats?.requests}, totalCount=${summary?.stats?.totalCount}`);
    return { code, rows, summary, secs };
}

const BASE = ['symbol', 'exchange', 'name', 'market', 'asOf'];
const DEFAULTS = ['close', 'change', 'change_abs', 'volume', 'market_cap_basic', 'price_earnings_ttm', 'sector', 'industry', 'Recommend.All', 'RSI', 'SMA50', 'SMA200', 'Perf.W', 'Perf.1M', 'Perf.YTD', 'Volatility.D', 'relative_volume_10d_calc', 'type', 'description', 'currency', 'average_volume_10d_calc', 'float_shares_outstanding', 'beta_1_year'];
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const sortedDesc = (rows, key) => rows.every((r, i) => i === 0 || !num(r[key]) || !num(rows[i - 1][key]) || rows[i - 1][key] >= r[key]);
const sortedAsc = (rows, key) => rows.every((r, i) => i === 0 || !num(r[key]) || !num(rows[i - 1][key]) || rows[i - 1][key] <= r[key]);

// 1. america, default columns, two pages
{
    const { code, rows, summary } = await runActor('america-default-2pages', { market: 'america', maxResults: 600 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 600, `600 rows, got ${rows.length}`);
    assert(summary?.stats?.pages === 2 && summary?.stats?.totalCount > 10000, `two pages over a large universe (${summary?.stats?.pages} pages, total ${summary?.stats?.totalCount})`);
    for (const r of rows) assert([...BASE, ...DEFAULTS].every((f) => f in r), `fields present on ${r.symbol}: missing ${[...BASE, ...DEFAULTS].filter((f) => !(f in r)).join(',')}`);
    assert(rows.every((r) => r.market === 'america' && /^[A-Z]+:/.test(r.symbol) && r.exchange === r.symbol.split(':')[0]), 'symbol and exchange shape');
    assert(sortedDesc(rows, 'market_cap_basic'), 'default sort market_cap_basic desc');
    assert(rows.filter((r) => num(r.close) && typeof r.sector === 'string').length > 500, 'close and sector populated');
    assert(new Set(rows.map((r) => r.symbol)).size === rows.length, 'no duplicate symbols across pages');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} ${r.description} cap=${r.market_cap_basic} close=${r.close}`).join(' | '));
    console.log('  sample row:', JSON.stringify(rows[0]));
}
// 2. korea, preset large-cap-gainers
{
    const { code, rows, summary } = await runActor('korea-large-cap-gainers', { market: 'korea', preset: 'large-cap-gainers', maxResults: 50 });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0 && rows.length <= 50, `1..50 rows, got ${rows.length}`);
    assert(rows.every((r) => r.change > 0 && r.market_cap_basic > 1e10 && r.type === 'stock' && r.currency === 'KRW' && r.exchange === 'KRX'), 'gainers filter applied in KRW');
    assert(sortedDesc(rows, 'change'), 'sorted by change desc');
    assert(summary?.request?.presetDefinition?.filters?.length >= 5 && 'Value.Traded' in rows[0], 'preset definition recorded and preset columns added');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} ${r.description} +${r.change.toFixed(2)}%`).join(' | '));
}
// 3. japan, preset oversold-rsi
{
    const { code, rows } = await runActor('japan-oversold-rsi', { market: 'japan', preset: 'oversold-rsi', maxResults: 40 });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0, `rows, got ${rows.length}`);
    assert(rows.every((r) => r.RSI < 30 && r.average_volume_10d_calc > 100000 && r.currency === 'JPY'), 'RSI below 30 and volume floor');
    assert(sortedAsc(rows, 'RSI'), 'sorted by RSI asc');
    console.log('  lowest 3:', rows.slice(0, 3).map((r) => `${r.symbol} ${r.description} RSI=${r.RSI.toFixed(1)}`).join(' | '));
}
// 4. germany, preset high-dividend
{
    const { code, rows } = await runActor('germany-high-dividend', { market: 'germany', preset: 'high-dividend', maxResults: 40 });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0, `rows, got ${rows.length}`);
    assert(rows.every((r) => r.dividends_yield_current > 4 && r.market_cap_basic > 1e9), 'yield and cap filter');
    assert(sortedDesc(rows, 'dividends_yield_current'), 'sorted by yield desc');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} ${r.description} yield=${r.dividends_yield_current.toFixed(2)}%`).join(' | '));
}
// 5. america, preset 52w-high (column-to-column comparison)
{
    const { code, rows } = await runActor('america-52w-high', { market: 'america', preset: '52w-high', maxResults: 40 });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0, `rows, got ${rows.length}`);
    assert(rows.every((r) => num(r.close) && num(r.price_52_week_high) && r.close >= r.price_52_week_high - 1e-9), 'close at or above the 52-week high');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} close=${r.close} high52=${r.price_52_week_high}`).join(' | '));
}
// 6. coin, preset crypto-top-volume (market defaults to coin)
{
    const { code, rows, summary } = await runActor('coin-crypto-top-volume', { preset: 'crypto-top-volume', maxResults: 50 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 50, `50 rows, got ${rows.length}`);
    assert(summary?.request?.market === 'coin' && rows.every((r) => r.market === 'coin' && r.exchange === 'CRYPTO'), 'market defaulted to coin');
    assert(sortedDesc(rows, '24h_vol_cmc') && rows.every((r) => num(r['24h_vol_cmc']) && typeof r.base_currency === 'string'), 'sorted by 24h volume with coin columns');
    assert(rows.slice(0, 10).some((r) => r.base_currency === 'BTC') && rows.slice(0, 10).some((r) => r.base_currency === 'USDT'), 'BTC and USDT in the top 10 by volume');
    console.log('  top 5:', rows.slice(0, 5).map((r) => `${r.base_currency} vol24h=${Math.round(r['24h_vol_cmc'] / 1e6)}M cap=${Math.round((r.market_cap_calc || 0) / 1e9)}B`).join(' | '));
}
// 7. crypto pairs with custom filters (exchange, quote currency, type) and own columns/sort
{
    const { code, rows } = await runActor('crypto-custom-filters', {
        market: 'crypto',
        columns: ['name', 'close', 'change', 'volume', 'exchange', 'type', 'currency', 'description', 'RSI'],
        filters: [{ left: 'exchange', operation: 'equal', right: 'BINANCE' }, { left: 'type', operation: 'equal', right: 'spot' }, { left: 'currency', operation: 'in_range', right: ['USDT'] }],
        sortBy: 'volume', sortOrder: 'desc', maxResults: 30,
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 30, `30 rows, got ${rows.length}`);
    assert(rows.every((r) => r.exchange === 'BINANCE' && r.type === 'spot' && r.currency === 'USDT' && /USDT$/.test(r.name)), 'exchange, type and quote currency filters');
    assert(sortedDesc(rows, 'volume') && Object.keys(rows[0]).length === BASE.length + 9 - 2, `only the requested columns plus base fields (${Object.keys(rows[0]).length} keys)`);
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} vol=${r.volume} chg=${r.change?.toFixed(2)}%`).join(' | '));
}
// 8. forex with a column-to-column filter and filter2 OR group
{
    const { code, rows } = await runActor('forex-filters', {
        market: 'forex',
        columns: ['name', 'close', 'change', 'SMA200', 'RSI', 'exchange', 'description'],
        filters: [{ left: 'exchange', operation: 'equal', right: 'FX_IDC' }, { left: 'close', operation: 'greater', right: 'SMA200' }],
        filter2: { operator: 'or', operands: [{ expression: { left: 'RSI', operation: 'less', right: 40 } }, { expression: { left: 'RSI', operation: 'greater', right: 60 } }] },
        sortBy: 'RSI', sortOrder: 'asc', maxResults: 25,
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0 && rows.length <= 25, `rows, got ${rows.length}`);
    assert(rows.every((r) => r.exchange === 'FX_IDC' && r.close > r.SMA200 && (r.RSI < 40 || r.RSI > 60)), 'column comparison and OR group applied');
    console.log('  first 3:', rows.slice(0, 3).map((r) => `${r.symbol} close=${r.close} sma200=${r.SMA200} rsi=${r.RSI?.toFixed(1)}`).join(' | '));
}
// 9. futures, major US exchanges by volume
{
    const { code, rows } = await runActor('futures-us-volume', {
        market: 'futures',
        columns: ['name', 'close', 'change', 'volume', 'exchange', 'description', 'expiration', 'currency'],
        filters: [{ left: 'exchange', operation: 'in_range', right: ['CME', 'CME_MINI', 'CBOT', 'NYMEX', 'COMEX'] }],
        sortBy: 'volume', maxResults: 20,
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 20 && rows.every((r) => ['CME', 'CME_MINI', 'CBOT', 'NYMEX', 'COMEX'].includes(r.exchange)), 'US futures exchanges');
    assert(sortedDesc(rows, 'volume'), 'sorted by volume desc');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.symbol} ${r.description} vol=${r.volume}`).join(' | '));
}
// 10. snapshot of 20 mixed tickers (one bogus)
{
    const symbols = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NASDAQ:NVDA', 'NASDAQ:GOOGL', 'NASDAQ:AMZN', 'NASDAQ:META', 'NASDAQ:TSLA', 'NYSE:BRK.B', 'NYSE:JPM', 'NYSE:IBM', 'KRX:005930', 'KRX:000660', 'TSE:7203', 'XETR:SAP', 'LSE:SHEL', 'NSE:RELIANCE', 'HKEX:700', 'BINANCE:BTCUSDT', 'FX:EURUSD', 'nasdaq:nope_zz9'];
    const { code, rows, summary } = await runActor('snapshot-20', { mode: 'snapshot', symbols, columns: ['name', 'close', 'change', 'volume', 'market_cap_basic', 'currency', 'type', 'description', 'Recommend.All'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 19, `19 rows (one bogus ticker dropped), got ${rows.length}`);
    assert(summary?.stats?.requests === 1 && summary.stats.missingSymbols.length === 1 && summary.stats.missingSymbols[0] === 'NASDAQ:NOPE_ZZ9', `one request, bogus ticker reported (${JSON.stringify(summary?.stats?.missingSymbols)})`);
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    assert(bySym.get('KRX:005930')?.currency === 'KRW' && bySym.get('FX:EURUSD')?.type === 'forex' && bySym.get('BINANCE:BTCUSDT')?.type === 'spot' && bySym.get('NYSE:BRK.B')?.close > 100, 'mixed exchanges resolved with native values');
    assert(rows.every((r) => r.market === 'global' && num(r.close)), 'all rows priced');
    console.log('  sample:', JSON.stringify(bySym.get('KRX:005930')));
}
// 11. fields catalog for america (metainfo) and probe fallback for global
{
    const { code, rows } = await runActor('fields-america', { mode: 'fields', market: 'america' });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 3000, `metainfo catalog has thousands of fields, got ${rows.length}`);
    const byName = new Map(rows.map((r) => [r.field, r]));
    assert(byName.get('sector')?.type === 'text' && byName.get('sector')?.valueCount >= 15 && byName.get('RSI')?.type === 'number' && byName.get('market_cap_basic') && byName.get('name')?.source === 'extra', 'types, enumerations and extras');
    const verified = rows.filter((r) => r.verified).length;
    assert(verified > 2500 && typeof byName.get('close')?.sampleValue === 'number' && byName.get('close')?.verified === true && /^[A-Z]+:/.test(byName.get('close')?.sampleSymbol || ''), `catalog verified by a one-request scan (${verified}/${rows.length} returned values)`);
    console.log(`  america catalog: ${rows.length} fields, ${verified} returned a value for one of the three largest symbols; sample close=${byName.get('close')?.sampleValue} (${byName.get('close')?.sampleSymbol})`);
    console.log('  sector values:', (byName.get('sector')?.values || []).slice(0, 5).join(', '), `(+${(byName.get('sector')?.valueCount || 0) - 5})`);
    const g = await runActor('fields-global-probe', { mode: 'fields', market: 'global' });
    assert(g.code === 0 && g.rows.length > 120 && g.summary?.stats?.fieldSource === 'scan-probe', `global falls back to the one-row probe (${g.rows.length} rows, ${g.summary?.stats?.fieldSource})`);
    assert(g.rows.every((r) => r.verified === true && r.sampleValue !== null), 'probe keeps only the names that returned a value');
    console.log(`  global probe: ${g.summary?.stats?.fieldsVerified}/${g.summary?.stats?.fieldsListed} curated names returned values`);
}
// 12. invalid inputs fail with exit code 91 and no rows
{
    const bad = [
        ['bad-operation', { market: 'america', filters: [{ left: 'close', operation: 'bigger_than', right: 10 }] }],
        ['bad-market', { market: 'mars' }],
        ['preset-wrong-market', { market: 'forex', preset: 'high-dividend' }],
        ['snapshot-no-symbols', { mode: 'snapshot' }],
        ['scanner-400-operation', { market: 'america', filters: [{ left: 'close', operation: 'match', right: 'abc' }], maxResults: 5 }],
        ['scanner-400-type', { market: 'america', filters: [{ left: 'sector', operation: 'greater', right: 5 }], maxResults: 5 }],
    ];
    for (const [name, input] of bad) {
        const { code, rows } = await runActor(name, input);
        assert(code === 91 && rows.length === 0, `${name}: exit 91 (got ${code}) and no rows (${rows.length})`);
    }
}
// 13. unknown column and unknown filter field: not errors at the scanner, reported in SUMMARY notes
{
    const { code, rows, summary } = await runActor('unknown-column', { market: 'america', columns: ['name', 'close', 'not_a_column_zz'], maxResults: 5 });
    assert(code === 0 && rows.length === 5 && rows.every((r) => r.not_a_column_zz === null), 'unknown column comes back as null');
    assert(summary?.stats?.allNullColumns?.includes('not_a_column_zz') && summary.notes.length === 1, `unknown column listed in SUMMARY (${JSON.stringify(summary?.stats?.allNullColumns)})`);
    const z = await runActor('unknown-filter-field', { market: 'america', filters: [{ left: 'not_a_field_zz', operation: 'greater', right: 1 }], maxResults: 5 });
    assert(z.code === 0 && z.rows.length === 0 && z.summary?.stats?.totalCount === 0 && z.summary.notes.some((n) => n.startsWith('No symbol matched')), 'unknown filter field matches nothing and is explained');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
