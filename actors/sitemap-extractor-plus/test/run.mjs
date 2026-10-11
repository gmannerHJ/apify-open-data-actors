// Local end-to-end test: runs the Actor with the SDK's local storage (no Apify account needed)
// against (1) a synthetic server covering robots discovery, gzipped + nested + text sitemaps,
// changedSince and status checks, and (2) live sites.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
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
    return readdirSync(dir)
        .filter((f) => /^\d+\.json$/.test(f))
        .sort()
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
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
    results.push({ name, exitCode: code, rows: rows.length, secs, stopReason: summary?.stopReason, sitemaps: summary?.stats?.sitemapsFetched, failed: summary?.stats?.sitemapsFailed });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, stop=${summary?.stopReason}`);
    return { code, rows, summary, secs };
}

// ---------- synthetic server ----------
const recent = new Date(Date.now() - 2 * 86400e3).toISOString();
const old = '2020-01-01T00:00:00Z';
function startServer() {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            const base = `http://127.0.0.1:${server.address().port}`;
            const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
            switch (req.url) {
                case '/robots.txt':
                    return send(200, 'text/plain', `User-agent: *\nDisallow: /private\nSitemap: ${base}/sitemap_index.xml.gz\n`);
                case '/sitemap_index.xml.gz':
                    return send(200, 'application/x-gzip', gzipSync(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/a.xml</loc><lastmod>${recent}</lastmod></sitemap>
  <sitemap><loc>${base}/b.xml.gz</loc><lastmod>${old}</lastmod></sitemap>
  <sitemap><loc>${base}/c.txt</loc></sitemap>
  <sitemap><loc>${base}/missing.xml</loc></sitemap>
</sitemapindex>`));
                case '/a.xml':
                    return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>${base}/blog/new-post?x=1&amp;y=2</loc><lastmod>${recent}</lastmod><changefreq>daily</changefreq><priority>0.8</priority>
    <xhtml:link rel="alternate" hreflang="de" href="${base}/de/blog/new-post"/>
    <image:image><image:loc>${base}/img/1.jpg</image:loc></image:image>
  </url>
  <url><loc>${base}/blog/old-post</loc><lastmod>${old}</lastmod></url>
  <url><loc>${base}/about</loc></url>
  <url><loc>${base}/gone</loc><lastmod>${recent}</lastmod></url>
</urlset>`);
                case '/b.xml.gz':
                    return send(200, 'application/octet-stream', gzipSync(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/shop/1</loc><lastmod>${old}</lastmod></url><url><loc>${base}/shop/2</loc></url></urlset>`));
                case '/c.txt':
                    return send(200, 'text/plain', `${base}/docs/x\n${base}/docs/y\n`);
                case '/gone':
                    return send(404, 'text/html', 'nope');
                case '/missing.xml':
                    return send(404, 'text/plain', 'no');
                default:
                    if (req.url.startsWith('/de/')) { res.writeHead(302, { location: `${base}/blog/new-post` }); return res.end(); }
                    return send(200, 'text/html', '<html>ok</html>');
            }
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
try {
    // 1. full crawl of the synthetic site with status checks
    {
        const { code, rows, summary } = await runActor('synthetic-full-status', { startUrls: [{ url: base }], checkStatus: true, maxUrls: 100 });
        assert(code === 0, 'exit code 0');
        assert(rows.length === 8, `expected 8 unique URLs (4 + 2 + 2), got ${rows.length}`);
        assert(summary?.stats?.sitemapsFetched === 4, `4 sitemaps fetched, got ${summary?.stats?.sitemapsFetched}`);
        assert(summary?.stats?.sitemapsFailed === 1, `1 failed sitemap (missing.xml), got ${summary?.stats?.sitemapsFailed}`);
        assert(rows.every((r) => r.discoveredVia === 'robots'), 'discoveredVia robots');
        const post = rows.find((r) => r.url.endsWith('/blog/new-post?x=1&y=2'));
        assert(post, 'entity-decoded loc present');
        assert(post && post.lastmod === new Date(recent).toISOString() && post.changefreq === 'daily' && post.priority === 0.8, 'lastmod/changefreq/priority parsed');
        assert(post && post.alternatesCount === 1 && post.imageCount === 1, 'alternates and images counted');
        assert(post && post.section === '/blog' && post.status === 200, 'section and status');
        assert(rows.find((r) => r.url.endsWith('/gone'))?.status === 404, '404 status recorded');
        assert(rows.filter((r) => r.sitemapKind === 'text').length === 2, 'text sitemap parsed');
        assert(rows.filter((r) => r.sitemapUrl.endsWith('b.xml.gz')).length === 2, 'gzipped leaf parsed');
        assert(rows.every((r) => typeof r.statusCheckedAt === 'string'), 'statusCheckedAt on all rows');
        console.log('  sample row:', JSON.stringify(post));
    }
    // 2. changedSince: only recent URLs; old child sitemap skipped without download
    {
        const { code, rows, summary } = await runActor('synthetic-changedSince', { startUrls: [{ url: base }], changedSince: '7d', maxUrls: 100 });
        assert(code === 0, 'exit code 0');
        assert(rows.length === 2, `expected 2 recent URLs, got ${rows.length}`);
        assert(summary?.stats?.sitemapsSkippedByDate === 1, `old child sitemap skipped, got ${summary?.stats?.sitemapsSkippedByDate}`);
        assert(summary?.stats?.urlsFilteredByDate === 4, `4 URLs filtered by date (1 old + 3 without lastmod), got ${summary?.stats?.urlsFilteredByDate}`);
    }
    // 3. invalid input produces a clear failure
    {
        const { code, rows } = await runActor('invalid-changedSince', { startUrls: [{ url: base }], changedSince: 'yesterday-ish' });
        assert(code !== 0 && rows.length === 0, 'invalid changedSince fails the run');
    }
} finally {
    server.close();
}

// 4. live: direct sitemap index (nested), small cap
{
    const { code, rows } = await runActor('live-gov.uk-index', { startUrls: [{ url: 'https://www.gov.uk/sitemap.xml' }], maxUrls: 300, maxSitemaps: 3 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 300, `300 rows capped, got ${rows.length}`);
    assert(rows.every((r) => r.url.startsWith('https://www.gov.uk/') && r.sitemapDepth === 1), 'nested leaf rows');
    assert(rows.filter((r) => r.lastmod).length > 0, 'lastmod present on live rows');
    console.log('  sample row:', JSON.stringify(rows[0]));
}
// 5. live: robots.txt discovery on a large multi-sitemap site, changedSince 30 days
{
    const { code, rows, summary } = await runActor('live-bbc.com-robots', { startUrls: [{ url: 'https://www.bbc.com' }], maxUrls: 200, maxSitemaps: 6 });
    assert(code === 0, 'exit code 0');
    assert(summary?.stats?.sitemapsDiscovered >= 10, `robots.txt discovery found >=10 sitemaps, got ${summary?.stats?.sitemapsDiscovered}`);
    assert(rows.length > 0 && rows.length <= 200, `rows within cap, got ${rows.length}`);
    assert(rows.every((r) => r.discoveredVia === 'robots' && r.url && r.sitemapUrl && r.site), 'row fields present');
    console.log('  sample row:', JSON.stringify(rows[0]));
    console.log('  sections:', JSON.stringify(summary?.sections?.slice(0, 5)));
}
// 6. live: status checks on a small real sitemap
{
    const { code, rows } = await runActor('live-apify.com-status', { startUrls: [{ url: 'https://apify.com/sitemap.xml' }], maxUrls: 40, checkStatus: true });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 40, `40 rows, got ${rows.length}`);
    const ok = rows.filter((r) => typeof r.status === 'number').length;
    assert(ok >= 36, `status numeric on >=36/40 rows, got ${ok}`);
    console.log('  status histogram:', JSON.stringify(rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {})));
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
