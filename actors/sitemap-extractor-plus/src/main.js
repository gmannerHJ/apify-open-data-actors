import { Actor, log } from 'apify';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const COMMON_SITEMAP_PATHS = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz',
    '/sitemaps.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml', '/sitemap.txt',
];
const SITEMAP_CONCURRENCY = 2;
const STATUS_CONCURRENCY = 5;
const PUSH_BATCH = 500;
const SITEMAP_HOST_GAP_MS = 250;
const STATUS_HOST_GAP_MS = 200;

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- input ----------

function parseChangedSince(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const s = String(value).trim();
    const rel = /^(\d+)\s*([hdwm])$/i.exec(s);
    if (rel) {
        const unitMs = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[rel[2].toLowerCase()];
        return new Date(Date.now() - Number(rel[1]) * unitMs);
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
        throw new InputError(`changedSince "${value}" is not an ISO date (2026-10-01), an ISO datetime, or a relative period such as 24h, 7d, 2w, 1m.`);
    }
    return d;
}

function compilePattern(value, name) {
    if (!value) return null;
    try {
        return new RegExp(value, 'i');
    } catch (e) {
        throw new InputError(`${name} is not a valid regular expression: ${e.message}`);
    }
}

function normalizeStartUrls(startUrls) {
    if (!Array.isArray(startUrls) || startUrls.length === 0) {
        throw new InputError('startUrls must contain at least one site URL (https://example.com) or sitemap URL (https://example.com/sitemap.xml).');
    }
    const out = [];
    for (const entry of startUrls) {
        let raw = typeof entry === 'string' ? entry : entry?.url;
        if (!raw || typeof raw !== 'string') throw new InputError(`startUrls entry ${JSON.stringify(entry)} has no url.`);
        raw = raw.trim();
        if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
        let url;
        try {
            url = new URL(raw);
        } catch {
            throw new InputError(`startUrls entry "${raw}" is not a valid URL.`);
        }
        out.push(url);
    }
    return out;
}

function looksLikeSitemapUrl(url) {
    const p = url.pathname.toLowerCase();
    return p.endsWith('.xml') || p.endsWith('.xml.gz') || p.endsWith('.gz') || p.endsWith('.txt') || p.includes('sitemap');
}

// ---------- http ----------

const hostLastRequest = new Map();

async function politeWait(url, gapMs) {
    const host = new URL(url).host;
    const wait = (hostLastRequest.get(host) || 0) + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    hostLastRequest.set(host, Date.now());
}

async function httpFetch(url, { method = 'GET', headersOnly = false, userAgent, timeoutMs, retries = 3, gapMs = SITEMAP_HOST_GAP_MS }) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        await politeWait(url, gapMs);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method,
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'user-agent': userAgent,
                    accept: 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8',
                    'accept-encoding': 'gzip, deflate, br',
                },
            });
            if ((res.status === 429 || res.status >= 500) && attempt < retries) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                await res.body?.cancel().catch(() => {});
                await sleep(retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : 1000 * 2 ** attempt);
                continue;
            }
            let buf = null;
            if (method === 'HEAD' || headersOnly) {
                await res.body?.cancel().catch(() => {});
            } else {
                buf = Buffer.from(await res.arrayBuffer());
            }
            return {
                status: res.status,
                buf,
                contentType: res.headers.get('content-type') || '',
                finalUrl: res.url || url,
            };
        } catch (e) {
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : e;
            if (attempt < retries) await sleep(1000 * 2 ** attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${method} ${url} failed after ${retries} attempts: ${lastError?.message}`);
}

function decodeBody(buf, url) {
    let b = buf;
    if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
        try {
            b = gunzipSync(b);
        } catch (e) {
            throw new Error(`gzip decode failed for ${url}: ${e.message}`);
        }
    }
    let text = b.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
}

// ---------- parsing ----------

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (_name, jpath) => /(^|\.)(sitemap|url|link|image|video|item|entry)$/.test(jpath),
});

const text = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : null;
    return String(v);
};

function parseSitemap(body, url, contentType) {
    const trimmed = body.trimStart();
    if (!trimmed.startsWith('<')) {
        const urls = trimmed.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).map((loc) => ({ loc }));
        if (urls.length === 0) {
            throw new Error(`Not a sitemap: ${url} returned ${contentType || 'an unknown content type'} with neither XML nor URL lines (starts with "${trimmed.slice(0, 60).replace(/\s+/g, ' ')}")`);
        }
        return { kind: 'text', children: [], urls };
    }
    let doc;
    try {
        doc = xmlParser.parse(trimmed);
    } catch (e) {
        throw new Error(`XML parse error at ${url}: ${e.message}`);
    }
    if (doc.sitemapindex) {
        const list = doc.sitemapindex.sitemap || [];
        return {
            kind: 'index',
            children: list.map((s) => ({ loc: text(s.loc)?.trim(), lastmod: text(s.lastmod) })).filter((c) => c.loc),
            urls: [],
        };
    }
    if (doc.urlset) {
        const list = doc.urlset.url || [];
        const urls = list.map((u) => ({
            loc: text(u.loc)?.trim(),
            lastmod: text(u.lastmod),
            changefreq: text(u.changefreq),
            priority: text(u.priority),
            alternates: (u.link || [])
                .filter((l) => l && typeof l === 'object' && l['@_href'])
                .map((l) => ({ hreflang: l['@_hreflang'] ?? null, href: l['@_href'] })),
            imageCount: (u.image || []).length,
            videoCount: (u.video || []).length,
            news: u.news ? {
                title: text(u.news.title),
                publicationDate: text(u.news.publication_date),
                publicationName: text(u.news.publication?.name),
            } : null,
        })).filter((x) => x.loc);
        return { kind: 'urlset', children: [], urls };
    }
    if (doc.rss?.channel) {
        const items = [].concat(doc.rss.channel.item || []);
        const urls = items.map((i) => ({
            loc: text(Array.isArray(i.link) ? i.link[0] : i.link)?.trim(),
            lastmod: text(i.pubDate),
        })).filter((x) => x.loc);
        return { kind: 'rss', children: [], urls };
    }
    if (doc.feed) {
        const entries = [].concat(doc.feed.entry || []);
        const urls = entries.map((e) => {
            const links = [].concat(e.link || []);
            const alt = links.find((l) => l && l['@_href'] && l['@_rel'] !== 'self') || links[0];
            return { loc: alt?.['@_href'] ?? null, lastmod: text(e.updated) || text(e.published) };
        }).filter((x) => x.loc);
        return { kind: 'atom', children: [], urls };
    }
    const root = Object.keys(doc)[0];
    throw new Error(`Unrecognised XML at ${url}: root element <${root}> (expected <urlset> or <sitemapindex>). This is usually an HTML error or consent page.`);
}

function normDate(s) {
    if (!s) return null;
    const d = new Date(String(s).trim());
    return Number.isNaN(d.getTime()) ? null : d;
}

function sectionOf(urlString) {
    try {
        const seg = new URL(urlString).pathname.split('/').filter(Boolean)[0];
        return seg ? `/${seg}` : '/';
    } catch {
        return null;
    }
}

function hostOf(urlString) {
    try {
        return new URL(urlString).host;
    } catch {
        return null;
    }
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
        // Returns the number of events charged (= number of rows the caller may push) and whether the limit was hit.
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
    const {
        discoverFromRobots = true,
        keepUrlsWithoutLastmod = false,
        skipUnchangedSitemaps = true,
        checkStatus = false,
        maxUrls = 10000,
        maxSitemaps = 500,
        maxDepth = 5,
        requestTimeoutSecs = 60,
        userAgent = DEFAULT_UA,
    } = input;

    const starts = normalizeStartUrls(input.startUrls);
    const changedSince = parseChangedSince(input.changedSince);
    const includeRe = compilePattern(input.includeUrlPattern, 'includeUrlPattern');
    const excludeRe = compilePattern(input.excludeUrlPattern, 'excludeUrlPattern');
    if (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > 1_000_000) throw new InputError('maxUrls must be an integer between 1 and 1000000.');
    if (!Number.isInteger(maxSitemaps) || maxSitemaps < 1 || maxSitemaps > 20000) throw new InputError('maxSitemaps must be an integer between 1 and 20000.');
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new InputError('maxDepth must be an integer between 0 and 10.');
    const timeoutMs = Math.min(Math.max(Number(requestTimeoutSecs) || 60, 5), 300) * 1000;
    const http = { userAgent: String(userAgent || DEFAULT_UA), timeoutMs };

    const charger = await makeCharger();
    const start = await charger.charge('actor-start', 1);
    if (start.limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    log.info(`Starting: ${starts.length} start URL(s), maxUrls=${maxUrls}, changedSince=${changedSince ? changedSince.toISOString() : 'off'}, checkStatus=${checkStatus}`);

    const stats = {
        startUrls: starts.length,
        sitemapsDiscovered: 0,
        sitemapsFetched: 0,
        sitemapsFailed: 0,
        sitemapsSkippedByDate: 0,
        urlsSeen: 0,
        urlsListed: 0,
        urlsFilteredByDate: 0,
        urlsFilteredByPattern: 0,
        duplicates: 0,
        statusChecked: 0,
    };
    const sitemapSummaries = [];
    const sectionCounts = new Map();
    const seen = new Set();
    const visited = new Set();
    const queue = [];
    const pending = [];
    let stopReason = null;

    // Discovery.
    for (const startUrl of starts) {
        if (looksLikeSitemapUrl(startUrl)) {
            queue.push({ url: startUrl.href, depth: 0, discoveredVia: 'input', root: startUrl.href });
            continue;
        }
        const origin = startUrl.origin;
        const found = [];
        if (discoverFromRobots) {
            try {
                const res = await httpFetch(`${origin}/robots.txt`, http);
                if (res.status === 200) {
                    for (const line of decodeBody(res.buf, `${origin}/robots.txt`).split(/\r?\n/)) {
                        const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
                        if (!m) continue;
                        try {
                            found.push(new URL(m[1], `${origin}/`).href);
                        } catch { /* ignore malformed */ }
                    }
                    log.info(`${origin}/robots.txt lists ${found.length} sitemap(s)`);
                } else {
                    log.warning(`${origin}/robots.txt returned HTTP ${res.status}; trying common sitemap paths`);
                }
            } catch (e) {
                log.warning(`${origin}/robots.txt could not be fetched (${e.message}); trying common sitemap paths`);
            }
        }
        if (found.length === 0) {
            for (const path of COMMON_SITEMAP_PATHS) {
                const candidate = `${origin}${path}`;
                try {
                    const res = await httpFetch(candidate, http);
                    if (res.status !== 200) continue;
                    parseSitemap(decodeBody(res.buf, candidate), candidate, res.contentType);
                    found.push(candidate);
                    log.info(`Found sitemap at ${candidate}`);
                    break;
                } catch { /* try next */ }
            }
        }
        if (found.length === 0) {
            log.error(`No sitemap found for ${origin}: robots.txt has no Sitemap: lines and none of ${COMMON_SITEMAP_PATHS.join(', ')} returned a sitemap. Pass the sitemap URL directly if you know it.`);
            continue;
        }
        for (const u of [...new Set(found)]) queue.push({ url: u, depth: 0, discoveredVia: discoverFromRobots && found.length ? 'robots' : 'fallback', root: u });
    }
    stats.sitemapsDiscovered = queue.length;
    if (queue.length === 0) throw new Error('No sitemaps could be discovered for any start URL. See the log for per-site details.');

    async function checkStatuses(rows) {
        let i = 0;
        const workers = Array.from({ length: STATUS_CONCURRENCY }, async () => {
            while (i < rows.length) {
                const row = rows[i++];
                try {
                    let res = await httpFetch(row.url, { ...http, method: 'HEAD', retries: 2, gapMs: STATUS_HOST_GAP_MS });
                    if ([403, 405, 501].includes(res.status)) {
                        res = await httpFetch(row.url, { ...http, method: 'GET', headersOnly: true, retries: 2, gapMs: STATUS_HOST_GAP_MS });
                    }
                    row.status = res.status;
                    row.redirected = res.finalUrl !== row.url;
                    row.finalUrl = res.finalUrl;
                    row.contentType = res.contentType || null;
                } catch (e) {
                    row.status = null;
                    row.statusError = e.message;
                }
                row.statusCheckedAt = new Date().toISOString();
                stats.statusChecked++;
            }
        });
        await Promise.all(workers);
    }

    let chargeLimitReached = false;
    let flushing = Promise.resolve();
    // Serialised so that concurrent sitemap workers never interleave batches.
    function flush(final = false) {
        flushing = flushing.then(async () => {
            while (!chargeLimitReached && (pending.length >= PUSH_BATCH || (final && pending.length > 0))) {
                const batch = pending.splice(0, PUSH_BATCH);
                if (checkStatus) await checkStatuses(batch);
                const listed = await charger.charge('url-listed', batch.length);
                const rows = batch.slice(0, listed.allowed);
                if (rows.length > 0) {
                    await Actor.pushData(rows);
                    stats.urlsListed += rows.length;
                    for (const r of rows) {
                        const key = `${r.site}${r.section ?? ''}`;
                        sectionCounts.set(key, (sectionCounts.get(key) || 0) + 1);
                    }
                    if (checkStatus) {
                        const checked = await charger.charge('status-checked', rows.length);
                        if (checked.limitReached) {
                            chargeLimitReached = true;
                            stopReason = 'maximum charge reached (status-checked)';
                        }
                    }
                }
                if (listed.limitReached || rows.length < batch.length) {
                    chargeLimitReached = true;
                    stopReason = 'maximum charge reached (url-listed)';
                }
            }
        });
        return flushing;
    }

    async function processSitemap(job) {
        if (stopReason || visited.has(job.url)) return;
        if (visited.size >= maxSitemaps) {
            stopReason = `maxSitemaps (${maxSitemaps}) reached`;
            return;
        }
        visited.add(job.url);
        const summary = { sitemapUrl: job.url, depth: job.depth, discoveredVia: job.discoveredVia, kind: null, status: null, urlCount: 0, childCount: 0, listed: 0, error: null };
        sitemapSummaries.push(summary);
        try {
            const res = await httpFetch(job.url, http);
            summary.status = res.status;
            if (res.status !== 200) {
                summary.error = `HTTP ${res.status}`;
                stats.sitemapsFailed++;
                log.warning(`Sitemap ${job.url} returned HTTP ${res.status}`);
                return;
            }
            const parsed = parseSitemap(decodeBody(res.buf, job.url), job.url, res.contentType);
            summary.kind = parsed.kind;
            stats.sitemapsFetched++;
            if (parsed.children.length > 0) {
                summary.childCount = parsed.children.length;
                if (job.depth + 1 > maxDepth) {
                    log.warning(`Sitemap index ${job.url} is at depth ${job.depth}; its ${parsed.children.length} children exceed maxDepth=${maxDepth} and were skipped`);
                } else {
                    for (const child of parsed.children) {
                        const childLastmod = normDate(child.lastmod);
                        if (changedSince && skipUnchangedSitemaps && childLastmod && childLastmod < changedSince) {
                            stats.sitemapsSkippedByDate++;
                            continue;
                        }
                        let childUrl;
                        try {
                            childUrl = new URL(child.loc, job.url).href;
                        } catch {
                            continue;
                        }
                        queue.push({ url: childUrl, depth: job.depth + 1, discoveredVia: job.discoveredVia, root: job.root, lastmod: child.lastmod ?? null });
                    }
                }
            }
            summary.urlCount = parsed.urls.length;
            stats.urlsSeen += parsed.urls.length;
            const site = hostOf(job.url);
            for (const u of parsed.urls) {
                if (stopReason) break;
                const loc = u.loc;
                if (seen.has(loc)) {
                    stats.duplicates++;
                    continue;
                }
                if ((includeRe && !includeRe.test(loc)) || (excludeRe && excludeRe.test(loc))) {
                    stats.urlsFilteredByPattern++;
                    continue;
                }
                const lastmod = normDate(u.lastmod);
                if (changedSince && (lastmod ? lastmod < changedSince : !keepUrlsWithoutLastmod)) {
                    stats.urlsFilteredByDate++;
                    continue;
                }
                if (seen.size >= maxUrls) {
                    stopReason = `maxUrls (${maxUrls}) reached`;
                    break;
                }
                seen.add(loc);
                summary.listed++;
                const row = {
                    url: loc,
                    lastmod: lastmod ? lastmod.toISOString() : null,
                    lastmodRaw: u.lastmod ?? null,
                    changefreq: u.changefreq ?? null,
                    priority: u.priority !== null && u.priority !== undefined && u.priority !== '' && !Number.isNaN(Number(u.priority)) ? Number(u.priority) : null,
                    site: hostOf(loc) ?? site,
                    section: sectionOf(loc),
                    sitemapUrl: job.url,
                    sitemapRoot: job.root,
                    sitemapKind: parsed.kind,
                    sitemapDepth: job.depth,
                    discoveredVia: job.discoveredVia,
                    alternatesCount: u.alternates ? u.alternates.length : 0,
                    alternates: u.alternates && u.alternates.length ? u.alternates : null,
                    imageCount: u.imageCount ?? 0,
                    videoCount: u.videoCount ?? 0,
                    newsTitle: u.news?.title ?? null,
                    newsPublicationDate: u.news?.publicationDate ?? null,
                };
                pending.push(row);
            }
            await flush();
        } catch (e) {
            summary.error = e.message;
            stats.sitemapsFailed++;
            log.warning(`Sitemap failed: ${e.message}`);
        }
    }

    // Breadth-first crawl of the sitemap tree with bounded concurrency.
    await new Promise((resolve) => {
        let active = 0;
        let next = 0;
        const pump = () => {
            while (!stopReason && active < SITEMAP_CONCURRENCY && next < queue.length) {
                const job = queue[next++];
                active++;
                processSitemap(job)
                    .catch((e) => log.exception(e, `Unexpected error on ${job.url}`))
                    .finally(() => {
                        active--;
                        pump();
                    });
            }
            if (active === 0 && (stopReason || next >= queue.length)) resolve();
        };
        pump();
    });
    await flush(true);

    const sections = [...sectionCounts.entries()].sort((a, b) => b[1] - a[1]).map(([section, count]) => ({ section, count }));
    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        changedSince: changedSince ? changedSince.toISOString() : null,
        checkStatus,
        stats,
        sections,
        sitemaps: sitemapSummaries,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.urlsListed} URLs listed from ${stats.sitemapsFetched} sitemaps (${stats.sitemapsFailed} failed, ${stats.urlsFilteredByDate} filtered by date, ${stats.duplicates} duplicates); stop reason: ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.urlsListed} URLs from ${stats.sitemapsFetched} sitemaps (${summary.stopReason})`);
    if (stats.urlsListed === 0 && stats.sitemapsFetched === 0) {
        throw new Error(`Every sitemap failed (${stats.sitemapsFailed}); see SUMMARY in the key-value store for per-sitemap errors.`);
    }
}

await Actor.main(main);
