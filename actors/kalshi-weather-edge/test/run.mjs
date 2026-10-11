// Local end-to-end test against the live Kalshi, NWS and Open-Meteo APIs using the SDK's local storage (no account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, series: summary?.stats?.seriesScanned, found: summary?.stats?.marketsFound, scored: summary?.stats?.marketsScored, unscored: summary?.stats?.marketsUnscored, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, scored=${summary?.stats?.marketsScored}, unscored=${summary?.stats?.marketsUnscored}`);
    return { code, rows, summary, secs };
}

const FIELDS = ['ticker', 'eventTicker', 'seriesTicker', 'kind', 'title', 'bracketLabel', 'city', 'stationCode', 'station', 'lat', 'lon', 'timezone', 'targetDate', 'leadDays', 'unit', 'strikeType', 'floorStrike', 'capStrike', 'bracketLow', 'bracketHigh', 'closeTime', 'yesBid', 'yesAsk', 'yesMid', 'spread', 'lastPrice', 'volume', 'openInterest', 'bookYesBid', 'bookYesAsk', 'bookYesDepth', 'bookNoDepth', 'nwsHigh', 'nwsLow', 'nwsPop', 'openMeteoHigh', 'openMeteoLow', 'openMeteoPop', 'forecastValue', 'forecastSourcesUsed', 'sigma', 'modelProbability', 'edge', 'absEdge', 'scored', 'notes', 'settlementSource', 'rulesPrimary', 'fetchedAt'];

// 1. NYC high/low plus the multi-city daily rain series, with order books
{
    const { code, rows, summary } = await runActor('nyc-and-rain', { seriesTickers: ['KXHIGHNY', 'KXLOWTNYC', 'KXRAIN'], maxMarkets: 120 });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 20, `more than 20 open markets, got ${rows.length}`);
    for (const r of rows) assert(FIELDS.every((f) => f in r), `fields present on ${r.ticker}: missing ${FIELDS.filter((f) => !(f in r)).join(',')}`);
    const nyHigh = rows.filter((r) => r.seriesTicker === 'KXHIGHNY');
    assert(nyHigh.length >= 6, `KXHIGHNY has at least one event of 6 brackets, got ${nyHigh.length}`);
    assert(nyHigh.every((r) => r.city === 'New York City' && r.stationCode === 'CLINYC' && r.station === 'KNYC' && r.timezone === 'America/New_York' && r.unit === 'F' && r.kind === 'high'), 'KXHIGHNY station mapping');
    assert(nyHigh.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.targetDate) && r.closeTime > r.fetchedAt), 'target date parsed and market still open');
    const between = nyHigh.find((r) => r.strikeType === 'between');
    assert(between && between.bracketLow === between.floorStrike && between.bracketHigh === between.capStrike, `between bracket inclusive (${JSON.stringify([between?.floorStrike, between?.capStrike, between?.bracketLow, between?.bracketHigh])})`);
    const greater = nyHigh.find((r) => r.strikeType === 'greater');
    assert(greater && greater.bracketLow === greater.floorStrike + 1 && greater.bracketHigh === null, `greater bracket starts one degree above the strike (${greater?.floorStrike} -> ${greater?.bracketLow})`);
    const less = nyHigh.find((r) => r.strikeType === 'less');
    assert(less && less.bracketHigh === less.capStrike - 1 && less.bracketLow === null, `less bracket ends one degree below the strike (${less?.capStrike} -> ${less?.bracketHigh})`);
    const scored = rows.filter((r) => r.scored);
    assert(scored.length >= 12, `at least 12 scored markets, got ${scored.length}`);
    for (const r of scored) {
        assert(r.modelProbability > 0 && r.modelProbability < 1 && typeof r.yesMid === 'number' && Math.abs(r.edge - (r.modelProbability - r.yesMid)) < 1e-6, `edge = model - mid on ${r.ticker}`);
        assert(r.forecastSourcesUsed.length >= 1 && typeof r.forecastValue === 'number', `forecast attached on ${r.ticker}`);
        if (r.kind !== 'rain') assert(r.sigma > 1 && r.sigma < 15 && typeof r.nwsHigh === 'number' && typeof r.openMeteoHigh === 'number', `sigma and both forecast sources on ${r.ticker} (${r.sigma}, nws ${r.nwsHigh}, om ${r.openMeteoHigh})`);
        // NWS has no PoP block left for the current day late in the evening; Open-Meteo always has the day.
        if (r.kind === 'rain') assert(r.bracketLow === 0 && (typeof r.nwsPop === 'number' || typeof r.openMeteoPop === 'number') && typeof r.openMeteoPop === 'number', `rain market uses PoP on ${r.ticker} (nws ${r.nwsPop}, om ${r.openMeteoPop})`);
        assert(!(r.leadDays === 0 && r.localHourAtStation >= 12), `same-day market scored only before noon local (${r.ticker} at ${r.localHourAtStation}h)`);
    }
    // Same-day markets late in the local day are listed with observations but not scored.
    const lateToday = rows.filter((r) => r.leadDays === 0 && r.localHourAtStation >= 12);
    for (const r of lateToday) {
        assert(!r.scored && r.edge === null && /same-day market after 12:00 local/.test(r.notes[0] || ''), `late same-day market unscored with reason (${r.ticker}: ${r.notes[0]})`);
        if (r.country === 'US') assert(typeof r.observedHighSoFar === 'number' && typeof r.observedLowSoFar === 'number' && r.observedHighSoFar >= r.observedLowSoFar && r.lastObservationTime, `observations attached on ${r.ticker} (${r.observedHighSoFar}/${r.observedLowSoFar})`);
    }
    if (lateToday.length) console.log(`  ${lateToday.length} same-day markets after noon local left unscored; example:`, JSON.stringify({ ticker: lateToday[0].ticker, yesMid: lateToday[0].yesMid, observedHighSoFar: lateToday[0].observedHighSoFar, observedLowSoFar: lateToday[0].observedLowSoFar, notes: lateToday[0].notes }));
    // Probabilities of one event's exclusive brackets add up to about one.
    const byEvent = new Map();
    for (const r of scored.filter((x) => x.kind !== 'rain')) byEvent.set(r.eventTicker, (byEvent.get(r.eventTicker) || 0) + r.modelProbability);
    assert(byEvent.size >= 1, 'at least one fully scored temperature event');
    for (const [ev, sum] of byEvent) assert(sum > 0.97 && sum < 1.03, `bracket probabilities for ${ev} sum to ${sum.toFixed(3)}`);
    assert(rows.some((r) => r.bookYesDepth > 0 || r.bookNoDepth > 0), 'order book depth fetched');
    assert(rows.every((r) => r.yesMid === null || (r.yesMid >= 0 && r.yesMid <= 1)), 'mid between 0 and 1');
    const rain = rows.filter((r) => r.kind === 'rain');
    assert(rain.length >= 10 && new Set(rain.map((r) => r.city)).size >= 8, `rain markets across many cities (${rain.length} markets, ${new Set(rain.map((r) => r.city)).size} cities)`);
    assert(summary?.stats?.forecastFailures === 0 || summary.stats.forecastFailures < summary.stats.forecastFetches / 4, `forecast fetches mostly succeed (${summary?.stats?.forecastFailures}/${summary?.stats?.forecastFetches} failed)`);
    assert(Array.isArray(summary?.largestAbsoluteEdges) && summary.largestAbsoluteEdges.length > 0 && typeof summary.disclaimer === 'string', 'summary has top edges and the disclaimer');
    const sample = scored.find((r) => r.seriesTicker === 'KXHIGHNY' && r.strikeType === 'between' && r.leadDays === 1) || scored.find((r) => r.seriesTicker === 'KXHIGHNY') || scored[0];
    console.log('  sample row:', JSON.stringify({ ...sample, rulesPrimary: sample.rulesPrimary.slice(0, 80) }));
    console.log('  top edges:', JSON.stringify(summary.largestAbsoluteEdges.slice(0, 3)));
    console.log('  unscored reasons:', JSON.stringify(summary.stats.unscoredReasons));
}
// 2. all daily high series, city filter, no order book, unscored dropped, sigma scaled
{
    const { code, rows, summary } = await runActor('highs-chicago-denver', { seriesTickers: ['KXHIGH*'], cities: ['Chicago', 'CLIDEN'], includeOrderbook: false, includeUnscored: false, sigmaScale: 1.5, maxMarkets: 60 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 6, `Chicago and Denver high markets, got ${rows.length}`);
    assert(rows.every((r) => ['Chicago', 'Denver'].includes(r.city) && r.kind === 'high' && r.scored), `only scored Chicago/Denver highs (${[...new Set(rows.map((r) => r.city))]})`);
    assert(rows.every((r) => r.bookYesDepth === null && r.yesMid !== null), 'no order book, mid from market summary');
    const den = rows.find((r) => r.stationCode === 'CLIDEN' && r.leadDays === 1);
    if (den) assert(Math.abs(den.sigma - 4.0 * 1.5) < 1e-6, `Denver 1-day sigma scaled 4.0 x 1.5 (${den.sigma})`);
    assert(summary?.stats?.seriesScanned >= 40, `scanned all daily high series (${summary?.stats?.seriesScanned})`);
    console.log('  rows:', rows.map((r) => `${r.ticker} mid=${r.yesMid} p=${r.modelProbability} edge=${r.edge}`).join(' | '));
}
// 3. bad input fails clearly
{
    const { code, rows } = await runActor('invalid-type', { marketTypes: ['snow'] });
    assert(code !== 0 && rows.length === 0, 'unknown market type fails the run');
    const r2 = await runActor('invalid-sigma', { seriesTickers: ['KXHIGHNY'], sigmaOverrides: { CLINYC: -1 } });
    assert(r2.code !== 0 && r2.rows.length === 0, 'negative sigma override fails the run');
    const r3 = await runActor('unknown-series', { seriesTickers: ['KXNOPE*'] });
    assert(r3.code !== 0 && r3.rows.length === 0, 'series pattern matching nothing fails the run');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
