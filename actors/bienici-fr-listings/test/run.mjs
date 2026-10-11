// Local end-to-end test against the live Bien'ici API using the SDK's local storage (no Apify account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, requests: summary?.stats?.requests, siteTotal: summary?.stats?.totalMatching, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, requests=${summary?.stats?.requests}, stop=${summary?.stopReason}`);
    return { code, rows, summary, secs };
}

const FIELDS = ['id', 'url', 'transactionType', 'propertyType', 'title', 'price', 'pricePerSquareMeter', 'priceHasDecreased', 'priceHistory', 'surface', 'rooms', 'bedrooms', 'energyClass', 'energyValue', 'ghgClass', 'city', 'postalCode', 'departmentCode', 'lat', 'lon', 'locationPrecisionMeters', 'publicationDate', 'modificationDate', 'isNewBuild', 'isProfessional', 'accountType', 'advertiserName', 'photoCount', 'scrapedAt'];

// 1. sale listings in Lyon with price, surface and rooms filters, newest first
{
    const { code, rows, summary } = await runActor('lyon-buy-filtered', {
        transactionType: 'buy', locations: ['Lyon'], propertyTypes: ['flat'], minPrice: 150000, maxPrice: 400000, minSurface: 40, minRooms: 2, maxRooms: 4, maxResults: 60, pageSize: 50,
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 60, `60 rows (two pages of 50 capped at 60), got ${rows.length}`);
    assert(summary?.locations?.[0]?.name === 'Lyon' && summary.locations[0].type === 'city', `Lyon resolved as a city, got ${JSON.stringify(summary?.locations?.[0])}`);
    assert(summary?.stats?.totalMatching > 60, `site total larger than cap, got ${summary?.stats?.totalMatching}`);
    for (const r of rows) {
        assert(FIELDS.every((f) => f in r), `fields present on ${r.id}: missing ${FIELDS.filter((f) => !(f in r)).join(',')}`);
        assert(r.transactionType === 'sale' && r.propertyType === 'flat', `sale flat row ${r.id}`);
        assert(r.price >= 150000 && r.price <= 400000, `price within filter (${r.price})`);
        assert(r.surface >= 40 && r.rooms >= 2 && r.rooms <= 4, `surface/rooms within filter (${r.surface} m2, ${r.rooms} rooms)`);
        assert(/^69\d{3}$/.test(r.postalCode || '') || /^Lyon/.test(r.city || ''), `postcode or city is Lyon (${r.city} ${r.postalCode})`);
        assert(typeof r.lat === 'number' && typeof r.lon === 'number' && r.lat > 45.6 && r.lat < 45.9 && r.lon > 4.7 && r.lon < 5.0, `coordinates inside Lyon (${r.lat}, ${r.lon})`);
        assert(/^20\d\d-\d\d-\d\dT/.test(r.publicationDate || ''), `publicationDate ISO (${r.publicationDate})`);
        assert(r.url.startsWith('https://www.bienici.com/annonce/vente/'), `listing URL (${r.url})`);
    }
    assert(new Set(rows.map((r) => r.id)).size === rows.length, 'ids unique');
    const dates = rows.map((r) => r.publicationDate);
    assert(dates.every((d, i) => i === 0 || d <= dates[i - 1]), 'sorted newest first');
    assert(rows.filter((r) => r.energyClass).length >= rows.length * 0.6, `DPE class present on most rows (${rows.filter((r) => r.energyClass).length}/${rows.length})`);
    assert(rows.some((r) => r.isProfessional === true && r.advertiserName), 'agency rows carry advertiser name');
    assert(rows.every((r) => r.advertiserAccountId), 'advertiser account id on every row');
    assert(summary?.stats?.skippedOtherTypes >= 0, 'programme lots counted as skipped');
    console.log('  sample row:', JSON.stringify({ ...rows[0], description: rows[0].description ? `${rows[0].description.slice(0, 80)}...` : null }));
}
// 2. rentals by postcode with DPE filter, small cap, no description
{
    const { code, rows, summary } = await runActor('lyon-rent-dpe', {
        transactionType: 'rent', locations: ['69003', '69007'], propertyTypes: ['flat'], maxPrice: 1500, energyClasses: ['A', 'B', 'C', 'D'], maxResults: 25, includeDescription: false, includePhotos: true,
    });
    assert(code === 0, 'exit code 0');
    const expected = Math.min(25, summary?.stats?.totalMatching ?? 0);
    assert(rows.length === expected && rows.length > 0, `${expected} rows (min of cap and site total ${summary?.stats?.totalMatching}), got ${rows.length}`);
    assert(summary?.locations?.length === 2 && summary.locations.every((l) => l.type === 'arrondissement'), `postcodes resolved to arrondissements, got ${JSON.stringify(summary?.locations?.map((l) => [l.query, l.name, l.type]))}`);
    assert(rows.every((r) => r.transactionType === 'rent' && r.price <= 1500), 'rent rows under max price');
    assert(rows.every((r) => ['A', 'B', 'C', 'D'].includes(r.energyClass)), `DPE filter respected (${[...new Set(rows.map((r) => r.energyClass))]})`);
    // Zone searches are polygon matches on the site; a few ads near a border carry a neighbouring postcode.
    const inZone = rows.filter((r) => ['69003', '69007'].includes(r.postalCode)).length;
    assert(inZone >= rows.length * 0.8 && rows.every((r) => /^Lyon/.test(r.city || '')), `mostly postcodes 69003/69007 and all in Lyon (${inZone}/${rows.length}; ${[...new Set(rows.map((r) => r.postalCode))]})`);
    assert(rows.every((r) => !('description' in r) && Array.isArray(r.photos)), 'description omitted, photos included');
    console.log('  sample row:', JSON.stringify({ ...rows[0], photos: rows[0].photos.slice(0, 1) }));
}
// 3. publishedSince stops early on a newest-first sort; all-France castles without a location
{
    const { code, rows, summary } = await runActor('publishedSince-castles', { transactionType: 'buy', locations: [], propertyTypes: ['castle'], publishedSince: '30d', maxResults: 500 });
    assert(code === 0, 'exit code 0');
    const since = Date.now() - 30 * 86400e3;
    assert(rows.length > 0 && rows.length < 500, `some but not all castles are from the last 30 days, got ${rows.length}`);
    assert(rows.every((r) => new Date(r.publicationDate).getTime() >= since), 'all rows published within 30 days');
    assert(/older than publishedSince/.test(summary?.stopReason || ''), `stopped at the date cutoff, got "${summary?.stopReason}"`);
    assert(summary?.stats?.requests < summary?.stats?.totalMatching / 100 + 2, `did not page through everything (${summary?.stats?.requests} requests for ${summary?.stats?.totalMatching} total)`);
    console.log('  stats:', JSON.stringify(summary?.stats));
}
// 4. bad input fails clearly without rows
{
    const { code, rows } = await runActor('invalid-location', { locations: ['Zzqxv-not-a-place-123'] });
    assert(code !== 0 && rows.length === 0, 'unknown location fails the run');
    const r2 = await runActor('invalid-type', { locations: ['Lyon'], propertyTypes: ['villa'] });
    assert(r2.code !== 0 && r2.rows.length === 0, 'unknown property type fails the run');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
