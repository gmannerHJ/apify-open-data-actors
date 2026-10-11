// Local end-to-end test against live Google News RSS using the SDK's local storage (no Apify account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, feedsFailed: s.feedsFailed, seen: s.itemsSeen, decoded: `${s.decodeSucceeded ?? 0}/${s.decodeAttempted ?? 0}`, decodeSecs: s.decodeSecs, textOk: s.articleTextOk, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, decoded=${s.decodeSucceeded}/${s.decodeAttempted} (${s.decodeSecs}s), textOk=${s.articleTextOk}`);
    return { code, rows, summary, secs };
}

const FIELDS = ['id', 'title', 'publisher', 'publisherUrl', 'url', 'googleUrl', 'decoded', 'publishedAt', 'snippet', 'query', 'topic', 'feedUrl', 'language', 'country', 'fetchedAt'];

// 1. Five queries across three languages with decoding (decoding success rate over 100+ items)
{
    const runs = [
        ['queries-en', { queries: ['Tesla when:1d', 'Federal Reserve rates'], maxResults: 25 }],
        ['queries-de', { queries: ['Bundesliga', 'Deutsche Bahn'], language: 'de', country: 'DE', maxResults: 25 }],
        ['queries-ko', { queries: ['삼성전자'], language: 'ko', country: 'KR', maxResults: 25 }],
    ];
    let attempted = 0;
    let succeeded = 0;
    let decodeSecs = 0;
    for (const [name, input] of runs) {
        const { code, rows, summary } = await runActor(name, input);
        assert(code === 0, `${name}: exit code 0`);
        assert(rows.length >= 10, `${name}: at least 10 rows, got ${rows.length}`);
        for (const r of rows) assert(FIELDS.every((f) => f in r), `${name}: fields present on ${r.id?.slice(0, 12)}: missing ${FIELDS.filter((f) => !(f in r)).join(',')}`);
        assert(rows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.publishedAt || '')), `${name}: publishedAt ISO`);
        assert(rows.every((r) => r.title && (!r.publisher || !r.title.endsWith(` - ${r.publisher}`))), `${name}: publisher suffix stripped from titles`);
        assert(rows.every((r) => r.googleUrl.includes('news.google.com/rss/articles/')), `${name}: googleUrl kept`);
        assert(rows.every((r) => r.query && input.queries.includes(r.query) && r.topic === null), `${name}: query attached`);
        assert(rows.every((r) => r.language === (input.language || 'en-US') && r.country === (input.country || 'US')), `${name}: edition fields`);
        const dec = rows.filter((r) => r.decoded);
        assert(dec.every((r) => /^https?:\/\//.test(r.url) && !r.url.includes('news.google.com')), `${name}: decoded rows point at publisher sites`);
        assert(dec.length >= rows.length * 0.9, `${name}: >=90% decoded (${dec.length}/${rows.length})`);
        attempted += summary.stats.decodeAttempted;
        succeeded += summary.stats.decodeSucceeded;
        decodeSecs += summary.stats.decodeSecs;
        console.log('  sample row:', JSON.stringify(rows[0]).slice(0, 600));
    }
    console.log(`\n  DECODING across runs: ${succeeded}/${attempted} = ${(100 * succeeded / Math.max(1, attempted)).toFixed(1)}% in ${decodeSecs.toFixed(1)}s (${(1000 * decodeSecs / Math.max(1, attempted)).toFixed(0)} ms per item incl. parallelism)`);
    assert(attempted >= 100, `at least 100 items attempted (${attempted})`);
    assert(succeeded >= attempted * 0.9, `>=90% decoded overall (${succeeded}/${attempted})`);
}
// 2. Three topics, no decoding, publishedSince filter
{
    const { code, rows, summary } = await runActor('topics-nodecode', { topics: ['TECHNOLOGY', 'BUSINESS', 'SCIENCE'], decodeUrls: false, publishedSince: '3d', maxResults: 40 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 30, `>=30 rows across three topics, got ${rows.length}`);
    assert(rows.every((r) => ['TECHNOLOGY', 'BUSINESS', 'SCIENCE'].includes(r.topic) && r.query === null), 'topic attached');
    assert(rows.every((r) => r.decoded === false && r.url === r.googleUrl), 'undecoded rows keep the Google link');
    const since = new Date(Date.now() - 3 * 86400e3);
    assert(rows.every((r) => new Date(r.publishedAt) >= since), 'publishedSince honoured');
    assert(summary.feeds.length === 3 && summary.feeds.every((f) => f.status === 200 && f.items > 0), 'per-feed summary');
    console.log('  per feed:', summary.feeds.map((f) => `${f.label}: ${f.items} items, ${f.kept} kept`).join(' | '));
}
// 3. Custom feed URL (topic page copied from news.google.com) plus TOP stories in another edition
{
    const { code, rows } = await runActor('feedurl-fr', { feedUrls: ['https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB'], topics: ['TOP'], language: 'fr', country: 'FR', decodeUrls: false, maxResults: 15 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 15, `rows from the custom feed and TOP, got ${rows.length}`);
    assert(rows.some((r) => r.topic === 'TOP') && rows.some((r) => r.topic?.startsWith('topics/')), 'both feed kinds present');
}
// 4. Article text: publishers that serve plain HTML, then a mixed set to measure the realistic extraction rate
{
    const { code, rows, summary } = await runActor('article-text', { queries: ['site:bbc.com OR site:theguardian.com OR site:npr.org OR site:cnbc.com when:1d'], maxResults: 12, fetchArticleText: true });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 5, `rows, got ${rows.length}`);
    assert(rows.every((r) => 'articleText' in r && 'articleTextStatus' in r && 'articleTextChars' in r), 'article text fields present');
    const ok = rows.filter((r) => r.articleTextStatus === 'ok');
    assert(ok.length >= rows.length * 0.7, `most article texts extracted (${ok.length}/${rows.length}, statuses ${JSON.stringify(summary.stats.articleTextStatus)})`);
    assert(ok.every((r) => r.articleText.length >= 200 && r.articleTextChars === r.articleText.length && r.snippet), 'extracted text is substantial and the meta description filled the snippet');
    console.log('  text statuses:', JSON.stringify(summary.stats.articleTextStatus), `in ${summary.stats.articleTextSecs}s`);
    if (ok[0]) console.log('  sample text:', JSON.stringify({ url: ok[0].url, chars: ok[0].articleTextChars, start: ok[0].articleText.slice(0, 200) }));
    const mixed = await runActor('article-text-mixed', { queries: ['Tesla when:1d', 'Bundesliga'], language: 'en', country: 'US', maxResults: 20, fetchArticleText: true });
    assert(mixed.code === 0, 'exit code 0');
    const okMixed = mixed.rows.filter((r) => r.articleTextStatus === 'ok').length;
    console.log(`  mixed publishers: ${okMixed}/${mixed.rows.length} extracted; statuses ${JSON.stringify(mixed.summary.stats.articleTextStatus)} in ${mixed.summary.stats.articleTextSecs}s`);
    assert(okMixed >= mixed.rows.length * 0.4, `at least 40% of mixed publishers yield text (${okMixed}/${mixed.rows.length})`);
}
// 5. Invalid input fails clearly
{
    const r1 = await runActor('invalid-empty', {});
    assert(r1.code !== 0 && r1.rows.length === 0, 'no feeds fails the run');
    const r2 = await runActor('invalid-topic', { topics: ['WEATHER'] });
    assert(r2.code !== 0 && r2.rows.length === 0, 'unknown topic fails the run');
    const r3 = await runActor('invalid-since', { queries: ['x'], publishedSince: 'lately' });
    assert(r3.code !== 0 && r3.rows.length === 0, 'bad publishedSince fails the run');
    const r4 = await runActor('unknown-feed-id', { feedUrls: ['https://news.google.com/topics/CAAqBwgKMKHL9QowkqbaAgNOPE'] });
    assert(r4.code !== 0 && r4.rows.length === 0, 'Google\'s "feed not available" placeholder is treated as a failed feed');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
