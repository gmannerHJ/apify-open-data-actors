// Local end-to-end test against live storefronts using the SDK's local storage (no Apify account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, analyzed: summary?.stats?.storesAnalyzed, shopify: summary?.stats?.shopifyStores, failed: summary?.stats?.failed, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, analyzed=${summary?.stats?.storesAnalyzed}, failed=${summary?.stats?.failed}`);
    return { code, rows, summary, secs };
}

const FIELDS = ['storeUrl', 'domain', 'httpStatus', 'isShopify', 'storefrontType', 'shopName', 'myshopifyDomain', 'themeName', 'themeSchemaName', 'themeStoreId', 'themeSource', 'currency', 'country', 'productCount', 'productCountSource', 'collectionCount', 'lastProductUpdate', 'priceMin', 'priceMax', 'apps', 'appNames', 'appCount', 'appsByCategory', 'plusHints', 'likelyShopifyPlus', 'contactEmail', 'contactEmails', 'social', 'thirdPartyHosts', 'error', 'fetchedAt', 'durationMs'];
const byDomain = (rows, d) => rows.find((r) => r.domain === d);

// 1. a mixed list: well-known Shopify stores with known apps, a headless Shopify site, a non-Shopify site, an unreachable host
{
    const { code, rows, summary } = await runActor('mixed-live', {
        storeUrls: [{ url: 'https://www.allbirds.com' }, { url: 'beardbrand.com' }, { url: 'https://colourpop.com/' }],
        storeList: 'www.pipsnacks.com\nugmonk.com\nwww.gymshark.com\nexample.com\nthis-host-does-not-exist-zzqx.invalid\n# comment\nallbirds.com',
    });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 8, `8 rows (9 inputs, allbirds deduped), got ${rows.length}`);
    for (const r of rows) assert(FIELDS.every((f) => f in r), `fields present on ${r.domain}: missing ${FIELDS.filter((f) => !(f in r)).join(',')}`);

    const allbirds = byDomain(rows, 'allbirds.com');
    assert(allbirds?.isShopify && allbirds.storefrontType === 'liquid', 'allbirds detected as a Liquid Shopify storefront');
    assert(allbirds?.myshopifyDomain === 'weareallbirds.myshopify.com', `allbirds myshopify domain (${allbirds?.myshopifyDomain})`);
    assert(allbirds?.themeSchemaName === 'allbirds-theme' && allbirds.themeSource === 'custom', `allbirds theme (${allbirds?.themeSchemaName}, ${allbirds?.themeSource})`);
    assert(allbirds?.currency === 'USD' && allbirds.country === 'US', `allbirds currency/country (${allbirds?.currency}, ${allbirds?.country})`);
    assert(allbirds?.productCount > 300 && allbirds.productCountSource === 'meta.json' && allbirds.collectionCount > 100, `allbirds counts from meta.json (${allbirds?.productCount}, ${allbirds?.collectionCount})`);
    assert(allbirds?.appNames.includes('Yotpo') && allbirds.appNames.includes('Attentive'), `allbirds apps include Yotpo and Attentive (${allbirds?.appNames})`);
    assert(allbirds?.contactEmail === 'help@allbirds.com', `allbirds contact email (${allbirds?.contactEmail})`);
    assert(/^20\d\d-/.test(allbirds?.lastProductUpdate || '') && allbirds.productsSampled === 250 && allbirds.priceMin > 0, 'allbirds product feed read');
    assert(allbirds?.apps.every((a) => a.app && a.category && a.evidence), 'app evidence present');

    const beard = byDomain(rows, 'beardbrand.com');
    assert(beard?.themeSchemaName === 'Split' && beard.themeStoreId === 842 && beard.themeSource === 'theme-store', `beardbrand theme-store theme (${beard?.themeSchemaName} #${beard?.themeStoreId})`);
    assert(['Klaviyo', 'Recharge', 'Judge.me'].every((a) => beard?.appNames.includes(a)), `beardbrand apps Klaviyo/Recharge/Judge.me (${beard?.appNames})`);
    assert(beard?.appsByCategory.subscriptions?.includes('Recharge') && beard.appsByCategory.reviews?.includes('Judge.me'), 'beardbrand categories');
    assert(beard?.contactEmail === 'support@beardbrand.com', `beardbrand email (${beard?.contactEmail})`);

    const cp = byDomain(rows, 'colourpop.com');
    assert(['Klaviyo', 'Yotpo', 'Gorgias', 'Attentive', 'Okendo'].every((a) => cp?.appNames.includes(a)), `colourpop apps (${cp?.appNames})`);
    assert(cp?.productCount > 0 && cp.currency === 'USD', 'colourpop counts/currency');

    const ug = byDomain(rows, 'ugmonk.com');
    assert(ug?.appNames.includes('Stamped') && ug.contactEmail === 'info@ugmonk.com', `ugmonk Stamped + info@ (${ug?.appNames}, ${ug?.contactEmail})`);
    const pip = byDomain(rows, 'pipsnacks.com');
    assert(pip?.appNames.includes('Recharge') && pip.appNames.includes('Postscript') && pip.themeSchemaName === 'Dawn', `pipsnacks Recharge/Postscript on Dawn (${pip?.appNames}, ${pip?.themeSchemaName})`);

    const gym = byDomain(rows, 'gymshark.com');
    assert(gym?.isShopify === true && gym.storefrontType === 'headless' && gym.themeName === null, `gymshark headless (${gym?.storefrontType}, theme ${gym?.themeName})`);
    assert(gym?.myshopifyDomain === 'gymsharkusa.myshopify.com', `gymshark myshopify domain from HTML (${gym?.myshopifyDomain})`);

    const ex = byDomain(rows, 'example.com');
    assert(ex?.isShopify === false && ex.storefrontType === 'not-shopify' && ex.error === null, 'example.com is not Shopify and not an error');
    const bad = byDomain(rows, 'this-host-does-not-exist-zzqx.invalid');
    assert(bad && bad.error && bad.storefrontType === 'unreachable' && bad.httpStatus === null, `unreachable host recorded with error (${bad?.error})`);
    assert(summary?.stats?.failed === 1 && summary.stats.storesAnalyzed === 7 && summary.failures.length === 1, `summary stats (${JSON.stringify(summary?.stats)})`);
    assert(summary?.appTotals?.[0]?.stores >= 3, `app totals aggregated (${JSON.stringify(summary?.appTotals?.slice(0, 3))})`);
    assert(rows.every((r) => r.error || r.durationMs < 30000), 'per-store time under 30 s');
    console.log('  sample row:', JSON.stringify({ ...beard, thirdPartyHosts: beard.thirdPartyHosts.slice(0, 5), apps: beard.apps.slice(0, 4) }));
    console.log('  app totals:', JSON.stringify(summary?.appTotals));
}
// 2. onlyShopify drops non-Shopify rows; no product feed, no emails
{
    const { code, rows } = await runActor('onlyShopify-light', { storeList: 'example.com, www.ugmonk.com', onlyShopify: true, fetchProducts: false, extractEmails: false });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 1 && rows[0].domain === 'ugmonk.com', `only the Shopify store is output (${rows.map((r) => r.domain)})`);
    assert(rows[0].productCount > 0 && rows[0].productCountSource === 'meta.json' && rows[0].lastProductUpdate === null && rows[0].productsSampled === 0, 'count from meta.json without reading the product feed');
    assert(rows[0].contactEmail === null && rows[0].contactEmails.length === 0, 'emails not extracted');
}
// 3. bad input fails clearly
{
    const { code, rows } = await runActor('invalid-empty', { storeUrls: [], storeList: '' });
    assert(code !== 0 && rows.length === 0, 'empty input fails the run');
    const r2 = await runActor('invalid-maxStores', { storeList: 'ugmonk.com', maxStores: 0 });
    assert(r2.code !== 0 && r2.rows.length === 0, 'maxStores 0 fails the run');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
