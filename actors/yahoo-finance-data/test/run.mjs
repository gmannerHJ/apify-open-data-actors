// Local end-to-end test against Yahoo Finance's live endpoints using the SDK's local storage (no Apify account needed).
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
    const s = summary?.stats || {};
    results.push({ name, exitCode: code, rows: rows.length, secs, requests: s.requests, failed: s.tasksFailed, session: summary?.session?.strategy, blocked: (s.blockedEndpoints || []).map((b) => b.endpoint).join(',') || '-', stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, requests=${s.requests}, failed=${s.tasksFailed}, session=${summary?.session?.strategy}`);
    return { code, rows, summary, secs };
}

const US = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK-B', 'JPM', 'XOM'];
const NON_US = ['005930.KS', '7203.T', 'SAP.DE', 'ASML.AS', 'RELIANCE.NS'];
const OTHER = ['^GSPC', 'BTC-USD', 'EURUSD=X'];
const ALL = [...US, ...NON_US, ...OTHER];
const BASE_FIELDS = ['recordType', 'symbol', 'asOf', 'currency', 'exchange', 'fetchedAt'];

// 1. quotes: 10 US + 5 non-US + index + crypto + FX, plus one unknown symbol
{
    const { code, rows, summary } = await runActor('quotes', { mode: 'quotes', symbols: [...ALL, 'ZZZZNOTASYMBOL'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length === ALL.length, `${ALL.length} quote rows, got ${rows.length}`);
    assert(summary.failures.length === 1 && summary.failures[0].symbol === 'ZZZZNOTASYMBOL', 'unknown symbol reported as failure, not a crash');
    for (const r of rows) {
        assert(BASE_FIELDS.every((f) => f in r), `base fields on ${r.symbol}: missing ${BASE_FIELDS.filter((f) => !(f in r)).join(',')}`);
        assert(r.recordType === 'quote' && typeof r.regularMarketPrice === 'number' && r.regularMarketPrice > 0 && r.currency && r.exchange && /^\d{4}-/.test(r.asOf || ''), `quote plausible for ${r.symbol}`);
    }
    const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    assert(by['005930.KS']?.currency === 'KRW' && by['7203.T']?.currency === 'JPY' && by['SAP.DE']?.currency === 'EUR' && by['RELIANCE.NS']?.currency === 'INR', 'non-US currencies');
    assert(by['^GSPC']?.quoteType === 'INDEX' && by['BTC-USD']?.quoteType === 'CRYPTOCURRENCY' && by['EURUSD=X']?.quoteType === 'CURRENCY', 'index, crypto and FX types');
    assert(rows.filter((r) => r.source === 'quote').length === rows.length, `all quotes from v7/quote (crumb path), sources: ${JSON.stringify(rows.reduce((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {}))}`);
    assert(typeof by.AAPL?.marketCap === 'number' && typeof by.AAPL?.trailingPE === 'number' && typeof by.AAPL?.fiftyTwoWeekHigh === 'number', 'full numeric fields present');
    assert(summary.session.crumbObtained === true && summary.stats.requests <= 6, `crumb cached: ${summary.stats.requests} requests for 18 symbols`);
    console.log('  sample row:', JSON.stringify({ ...by.AAPL }).slice(0, 700));
}
// 2. history daily 5y for three symbols with dividends/splits
{
    const { code, rows, summary } = await runActor('history-5y-1d', { mode: 'history', symbols: ['AAPL', '005930.KS', 'SAP.DE'], interval: '1d', range: '5y' });
    assert(code === 0, 'exit code 0');
    const bars = rows.filter((r) => r.recordType === 'bar');
    const divs = rows.filter((r) => r.recordType === 'dividend');
    const bySym = (s) => bars.filter((r) => r.symbol === s);
    assert(bySym('AAPL').length >= 1200 && bySym('005930.KS').length >= 1100 && bySym('SAP.DE').length >= 1200, `about 1,250 daily bars per symbol: AAPL ${bySym('AAPL').length}, 005930.KS ${bySym('005930.KS').length}, SAP.DE ${bySym('SAP.DE').length}`);
    assert(divs.filter((d) => d.symbol === 'AAPL').length >= 18, `AAPL dividends over 5y (${divs.filter((d) => d.symbol === 'AAPL').length})`);
    const a = bySym('AAPL');
    assert(a.every((r) => typeof r.open === 'number' && typeof r.close === 'number' && typeof r.volume === 'number' && typeof r.adjClose === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.interval === '1d' && r.currency === 'USD'), 'bar fields');
    assert(a.every((r, i) => i === 0 || r.asOf > a[i - 1].asOf), 'bars sorted ascending');
    assert(a[0].adjClose <= a[0].close && Math.abs(a[a.length - 1].adjClose - a[a.length - 1].close) < 0.02, 'adjClose below close in the past, equal today');
    assert(bySym('005930.KS').every((r) => r.currency === 'KRW'), 'KRW bars');
    assert(summary.stats.charged['history-100bars'] === undefined || summary.stats.charged['history-100bars'] >= 36, 'charged by 100-bar blocks (local run: uncharged)');
    console.log('  sample bar:', JSON.stringify(a[a.length - 1]));
    console.log('  sample dividend:', JSON.stringify(divs.find((d) => d.symbol === 'AAPL')));
}
// 3. history 1m 5d for two symbols (two 7-day windows are not needed; one request each)
{
    const { code, rows, summary } = await runActor('history-5d-1m', { mode: 'history', symbols: ['MSFT', 'BTC-USD'], interval: '1m', range: '5d', adjusted: false, includeEvents: false });
    assert(code === 0, 'exit code 0');
    const msft = rows.filter((r) => r.symbol === 'MSFT');
    const btc = rows.filter((r) => r.symbol === 'BTC-USD');
    assert(msft.length >= 1500 && msft.length <= 2000, `MSFT 1m bars over 5 sessions (${msft.length})`);
    assert(btc.length >= 5000, `BTC-USD 1m bars over 5 days (${btc.length})`);
    assert(msft.every((r) => !('adjClose' in r) && r.interval === '1m'), 'adjusted=false omits adjClose');
    assert(summary.stats.requests <= 4, `one request per symbol (${summary.stats.requests})`);
    console.log('  last MSFT bar:', JSON.stringify(msft[msft.length - 1]));
}
// 3b. history 1m 1mo is split into 7-day windows
{
    const { code, rows, summary } = await runActor('history-1mo-1m-split', { mode: 'history', symbols: ['AAPL'], interval: '1m', range: '1mo', includeEvents: false, maxResults: 100000 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 7000, `about 20 sessions x 390 bars (${rows.length})`);
    assert(summary.stats.requests >= 5, `split into 7-day requests (${summary.stats.requests})`);
    assert(new Set(rows.map((r) => r.asOf)).size === rows.length, 'no duplicate bars across windows');
}
// 4. fundamentals for three symbols, default modules
{
    const { code, rows, summary } = await runActor('fundamentals', { mode: 'fundamentals', symbols: ['AAPL', '7203.T', 'ASML.AS'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 18, `3 symbols x 7 modules, got ${rows.length} (failures: ${JSON.stringify(summary.failures).slice(0, 200)})`);
    const aapl = Object.fromEntries(rows.filter((r) => r.symbol === 'AAPL').map((r) => [r.module, r]));
    assert(typeof aapl.summaryDetail?.data?.marketCap === 'number' && typeof aapl.financialData?.data?.totalRevenue === 'number' && typeof aapl.defaultKeyStatistics?.data?.sharesOutstanding === 'number', 'raw numbers, not {raw, fmt}');
    assert(typeof aapl.assetProfile?.data?.sector === 'string' && Array.isArray(aapl.assetProfile?.data?.companyOfficers), 'profile strings and arrays kept');
    assert(Array.isArray(aapl.recommendationTrend?.data?.trend) && typeof aapl.recommendationTrend.data.trend[0].strongBuy === 'number', 'recommendation trend');
    assert(rows.every((r) => r.currency && r.exchange && r.asOf), 'currency/exchange from the price module');
    console.log('  sample module:', JSON.stringify({ ...aapl.financialData, data: Object.fromEntries(Object.entries(aapl.financialData.data).slice(0, 8)) }));
}
// 4b. explicit modules incl. statements
{
    const { code, rows } = await runActor('fundamentals-statements', { mode: 'fundamentals', symbols: ['MSFT'], modules: ['incomeStatementHistory', 'balanceSheetHistoryQuarterly', 'earningsTrend', 'topHoldings'] });
    assert(code === 0, 'exit code 0');
    const inc = rows.find((r) => r.module === 'incomeStatementHistory');
    assert(inc && Array.isArray(inc.data.incomeStatementHistory) && typeof inc.data.incomeStatementHistory[0].totalRevenue === 'number', 'income statement years as numbers');
    assert(!rows.some((r) => r.module === 'topHoldings'), 'fund-only module absent for a stock (reported in SUMMARY)');
}
// 5. options for two symbols, nearest two expirations, greeks
{
    const { code, rows, summary } = await runActor('options', { mode: 'options', symbols: ['AAPL', 'TSLA'], optionsExpirations: 2 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 150, `contracts across 2 symbols x 2 expirations (${rows.length})`);
    const calls = rows.filter((r) => r.optionType === 'call');
    const puts = rows.filter((r) => r.optionType === 'put');
    assert(calls.length > 0 && puts.length > 0, 'calls and puts');
    assert(rows.every((r) => r.contractSymbol && typeof r.strike === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(r.expiration) && 'impliedVolatility' in r && 'openInterest' in r && 'delta' in r && 'gamma' in r && 'theta' in r && 'vega' in r && 'rho' in r && r.currency === 'USD'), 'option fields');
    assert(new Set(rows.filter((r) => r.symbol === 'AAPL').map((r) => r.expiration)).size === 2, 'two expirations for AAPL');
    const withGreeks = rows.filter((r) => typeof r.delta === 'number');
    assert(withGreeks.length >= rows.length * 0.8, `greeks computed on most contracts (${withGreeks.length}/${rows.length})`);
    assert(withGreeks.filter((r) => r.optionType === 'call').every((r) => r.delta >= 0 && r.delta <= 1) && withGreeks.filter((r) => r.optionType === 'put').every((r) => r.delta >= -1 && r.delta <= 0), 'delta ranges');
    assert(typeof summary.input.riskFreeRate === 'number' && summary.input.riskFreeRate > 0 && summary.input.riskFreeRate < 0.2, `risk-free rate from ^IRX (${summary.input.riskFreeRate})`);
    const atm = withGreeks.filter((r) => r.symbol === 'AAPL' && r.optionType === 'call').sort((a, b) => Math.abs(a.strike - a.underlyingPrice) - Math.abs(b.strike - b.underlyingPrice))[0];
    console.log('  ATM AAPL call:', JSON.stringify(atm));
}
// 6. search
{
    const { code, rows } = await runActor('search', { mode: 'search', queries: ['samsung electronics', 'vanguard total stock market'], maxResults: 8 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 8, `search rows (${rows.length})`);
    assert(rows.some((r) => r.symbol === '005930.KS' && r.query === 'samsung electronics'), 'Samsung found by name');
    assert(rows.some((r) => r.query === 'vanguard total stock market' && /^(ETF|MUTUALFUND)$/.test(r.quoteType)), 'fund found');
    assert(rows.every((r) => r.recordType === 'search' && r.exchange && r.shortName), 'search fields');
    console.log('  sample:', JSON.stringify(rows[0]));
}
// 7. news
{
    const { code, rows, summary } = await runActor('news', { mode: 'news', symbols: ['AAPL', '005930.KS', 'BTC-USD'], maxResults: 15 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 20, `news rows across 3 symbols (${rows.length})`);
    assert(rows.every((r) => r.recordType === 'news' && r.title && /^https?:\/\//.test(r.url) && /^\d{4}-/.test(r.publishedAt || '') && r.source), 'news fields');
    assert(rows.filter((r) => r.symbol === 'AAPL').every((r) => r.publisher), 'publisher present for search-sourced news');
    console.log('  sources:', JSON.stringify(rows.reduce((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {})), 'failures:', summary.failures.length);
    console.log('  sample:', JSON.stringify(rows[0]).slice(0, 400));
}
// 8. invalid input fails clearly
{
    const r1 = await runActor('invalid-mode', { mode: 'dividends', symbols: ['AAPL'] });
    assert(r1.code !== 0 && r1.rows.length === 0, 'unknown mode fails the run');
    const r2 = await runActor('invalid-interval', { mode: 'history', symbols: ['AAPL'], interval: '3m' });
    assert(r2.code !== 0 && r2.rows.length === 0, 'bad interval fails the run');
    const r3 = await runActor('invalid-no-symbols', { mode: 'quotes' });
    assert(r3.code !== 0 && r3.rows.length === 0, 'no symbols fails the run');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
