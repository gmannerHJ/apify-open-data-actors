// Local end-to-end test against the live Play Store using the SDK's local storage (no Apify account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, requests: summary?.stats?.requests, failed: summary?.stats?.failed, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, requests=${summary?.stats?.requests}, failed=${summary?.stats?.failed}`);
    return { code, rows, summary, secs };
}

const DETAIL_FIELDS = ['recordType', 'appId', 'url', 'title', 'developer', 'developerId', 'genre', 'genreId', 'installsText', 'minInstalls', 'maxInstalls', 'score', 'ratingsCount', 'histogram', 'price', 'currency', 'free', 'offersIAP', 'iapRange', 'adSupported', 'contentRating', 'released', 'updated', 'version', 'androidVersion', 'privacyPolicy', 'dataSafety', 'country', 'language', 'scrapedAt'];
const LIST_FIELDS = ['recordType', 'appId', 'url', 'title', 'developer', 'developerId', 'score', 'price', 'free', 'icon', 'country', 'language', 'scrapedAt'];

// 1. detail: package name, store URL, and a non-existent id (must be reported, not crash the run)
{
    const { code, rows, summary } = await runActor('detail', {
        mode: 'detail',
        appIds: ['com.spotify.music', 'https://play.google.com/store/apps/details?id=com.whatsapp&hl=en', 'com.does.not.exist.zzz123'],
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 2, `2 rows, got ${rows.length}`);
    assert(summary?.stats?.failed === 1 && /404/.test(summary?.failures?.[0]?.error || ''), 'missing app reported as 404 failure');
    for (const r of rows) {
        assert(DETAIL_FIELDS.every((f) => f in r), `detail fields present on ${r.appId}: missing ${DETAIL_FIELDS.filter((f) => !(f in r)).join(',')}`);
        assert(r.recordType === 'app' && r.minInstalls >= 1e8 && r.ratingsCount > 1e6, `installs/ratings plausible for ${r.appId}`);
        assert(Object.keys(r.histogram).join(',') === '1,2,3,4,5' && r.histogram[5] > r.histogram[1], 'histogram shape');
        assert(typeof r.updated === 'string' && r.updated > '2026-01', `updated is a recent ISO date (${r.updated})`);
        assert(r.dataSafety && Array.isArray(r.dataSafety.summary) && r.dataSafety.summary.length >= 2, `data-safety summary parsed for ${r.appId}`);
    }
    const spotify = rows.find((r) => r.appId === 'com.spotify.music');
    assert(spotify?.offersIAP === true && /\$/.test(spotify?.iapRange || ''), 'IAP flag and range');
    console.log('  sample row:', JSON.stringify({ ...spotify, description: undefined, recentChanges: undefined }).slice(0, 900));
}
// 2. search: one term, light rows
{
    const { code, rows } = await runActor('search', { mode: 'search', searchTerms: ['budget planner'], maxResults: 10 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 10, `10 rows, got ${rows.length}`);
    assert(rows.every((r, i) => r.recordType === 'search' && r.searchTerm === 'budget planner' && r.position === i + 1), 'search rows ordered with positions');
    assert(rows.every((r) => LIST_FIELDS.every((f) => f in r)), 'list fields present');
    console.log('  sample row:', JSON.stringify(rows[0]).slice(0, 400));
}
// 3. developer portfolio
{
    const { code, rows } = await runActor('developer', { mode: 'developer', developerIds: ['Spotify AB'], maxResults: 5 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 1 && rows.length <= 5, `1..5 rows, got ${rows.length}`);
    assert(rows.every((r) => r.recordType === 'developer' && r.developerQuery === 'Spotify AB' && r.developer === 'Spotify AB'), 'developer rows');
}
// 4. chart, light rows
{
    const { code, rows } = await runActor('chart', { mode: 'chart', chartCategory: 'FINANCE', chartCollection: 'TOP_FREE', maxResults: 10 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 10, `10 rows, got ${rows.length}`);
    assert(rows.every((r, i) => r.recordType === 'chart' && r.rank === i + 1 && r.chartCategory === 'FINANCE' && r.chartCollection === 'TOP_FREE' && r.snapshotAt), 'chart rows ranked');
    console.log('  top 3:', rows.slice(0, 3).map((r) => `${r.rank}. ${r.title} (${r.appId})`).join(' | '));
}
// 5. chart with full details (enrichment path), different store country
{
    const { code, rows, secs } = await runActor('chart-fullDetail-gb', { mode: 'chart', chartCategory: 'GAME', chartCollection: 'GROSSING', maxResults: 3, fullDetail: true, country: 'gb' });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 3, `3 rows, got ${rows.length}`);
    assert(rows.every((r, i) => r.recordType === 'app' && r.rank === i + 1 && r.country === 'gb' && typeof r.minInstalls === 'number'), 'enriched chart rows');
    assert(secs >= 3, `paced at >= 1 s per request (${secs}s for 4 requests)`);
}
// 6. input validation
{
    const { code, rows } = await runActor('invalid-mode', { mode: 'reviews' });
    assert(code !== 0 && rows.length === 0, 'invalid mode fails the run');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
