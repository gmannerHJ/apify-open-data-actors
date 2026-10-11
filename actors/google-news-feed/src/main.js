import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const RSS_BASE = 'https://news.google.com/rss';
const BATCHEXECUTE = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
const TOPICS = ['TOP', 'WORLD', 'NATION', 'BUSINESS', 'TECHNOLOGY', 'ENTERTAINMENT', 'SPORTS', 'SCIENCE', 'HEALTH'];
const MAX_RESULTS_CAP = 100;
const MAX_FEEDS = 200;
const FEED_GAP_MS = 400; // between feed downloads
const DECODE_CONCURRENCY = 5; // article redirect pages in flight
const DECODE_BATCH = 10; // ids per batchexecute call
const ARTICLE_CONCURRENCY = 5;
const ARTICLE_HOST_GAP_MS = 1000;
const ARTICLE_TIMEOUT_MS = 10000;
const ARTICLE_MAX_BYTES = 2 * 1024 * 1024;
const ARTICLE_TEXT_MAX_CHARS = 30000;
const ARTICLE_TEXT_MIN_CHARS = 200;
const REQUEST_TIMEOUT_MS = 30000;
const PUSH_BATCH = 50;

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- text helpers ----------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', deg: '°', middot: '·', bull: '•', times: '×' };
function decodeEntities(s) {
    if (!s) return '';
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&([a-z]+);/gi, (m, n) => (NAMED_ENTITIES[n.toLowerCase()] ?? m));
}
function safeCodePoint(n) {
    try {
        return String.fromCodePoint(n);
    } catch {
        return '';
    }
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------- input ----------

function parseSince(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const s = String(value).trim();
    const rel = /^(\d+)\s*([hdwm])$/i.exec(s);
    if (rel) {
        const unitMs = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[rel[2].toLowerCase()];
        return new Date(Date.now() - Number(rel[1]) * unitMs);
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new InputError(`publishedSince "${value}" is not an ISO date (2026-10-01), an ISO datetime, or a relative period such as 2h, 24h, 7d, 30d.`);
    return d;
}

function cleanList(values, name) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new InputError(`${name} must be a list of strings.`);
    return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

// Google's edition id is COUNTRY:lang, where lang is the language subtag except for a few editions
// that use a script or region variant.
function deriveCeid(language, country) {
    const l = language.toLowerCase();
    const special = { 'pt-br': 'pt-419', 'pt-pt': 'pt-150', 'es-419': 'es-419', 'zh-cn': 'zh-Hans', 'zh-hans': 'zh-Hans', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-hant': 'zh-Hant' };
    const lang = special[l] ?? l.split('-')[0];
    return `${country}:${lang}`;
}

function feedUrlFromInput(raw, edition) {
    let s = raw.trim();
    if (!/^https?:\/\//i.test(s)) s = `https://news.google.com/${s.replace(/^\/+/, '')}`;
    let u;
    try {
        u = new URL(s);
    } catch {
        throw new InputError(`feedUrls entry "${raw}" is not a valid URL.`);
    }
    if (!/(^|\.)news\.google\.com$/i.test(u.hostname)) throw new InputError(`feedUrls entry "${raw}" is not a news.google.com URL.`);
    const path = u.pathname.replace(/^\/rss(?=\/|$)/, '');
    if (/^\/(publications|stories)\//.test(path)) throw new InputError(`feedUrls entry "${raw}": Google publishes no RSS feed for publication and story pages. Use a search query such as site:example.com for a publisher.`);
    const m = /^\/(topics)\/([^/?#]+)/.exec(path) || /^\/(headlines\/section\/(?:topic|geo))\/([^/?#]+)/.exec(path);
    if (m) return { kind: m[1].replace('headlines/section/', ''), id: decodeURIComponent(m[2]), url: `${RSS_BASE}/${m[1]}/${m[2]}?${edition}` };
    if (/^\/search$/.test(path) && u.searchParams.get('q')) return { kind: 'search', id: u.searchParams.get('q'), url: `${RSS_BASE}/search?q=${encodeURIComponent(u.searchParams.get('q'))}&${edition}` };
    if (path === '/' || path === '' || path === '/home') return { kind: 'top', id: 'TOP', url: `${RSS_BASE}?${edition}` };
    throw new InputError(`feedUrls entry "${raw}" is not a Google News topic, section, location or search page.`);
}

// ---------- http ----------

async function fetchText(url, { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, attempts = 3, label = url, maxBytes = 0 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { method, body, redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers } });
            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel().catch(() => {});
                lastError = new Error(`HTTP ${res.status}`);
                if (attempt < attempts) {
                    const retryAfter = Number(res.headers.get('retry-after'));
                    const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 5000 : 1500) * 2 ** (attempt - 1);
                    log.warning(`${label}: HTTP ${res.status} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                    await sleep(delay);
                }
                continue;
            }
            let text;
            if (maxBytes > 0) {
                const reader = res.body?.getReader();
                const chunks = [];
                let size = 0;
                if (reader) {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        size += value.length;
                        if (size >= maxBytes) {
                            await reader.cancel().catch(() => {});
                            break;
                        }
                    }
                }
                text = { buffer: Buffer.concat(chunks), truncated: size >= maxBytes };
            } else {
                text = await res.text();
            }
            return { status: res.status, text, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
        } catch (e) {
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : e;
            if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${label}: ${lastError?.message || 'request failed'} (after ${attempts} attempts)`);
}

// ---------- RSS ----------

function tagText(xml, name) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
    if (!m) return null;
    let v = m[1].trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
    if (cdata) v = cdata[1];
    return decodeEntities(v).trim();
}

function parseFeed(xml) {
    const items = [];
    const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(xml))) {
        const it = m[1];
        const source = /<source(?:\s+url="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/i.exec(it);
        items.push({
            title: tagText(it, 'title'),
            link: tagText(it, 'link'),
            guid: tagText(it, 'guid'),
            pubDate: tagText(it, 'pubDate'),
            description: tagText(it, 'description'),
            publisher: source ? decodeEntities(source[2]).trim() : null,
            publisherUrl: source?.[1] ? decodeEntities(source[1]) : null,
        });
    }
    const channelTitle = tagText(xml.split('<item')[0], 'title');
    return { items, channelTitle };
}

function articleIdFromLink(link) {
    const m = /\/articles\/([A-Za-z0-9_-]+)/.exec(link || '');
    return m ? m[1] : null;
}

// Google appends " - Publisher"; some publishers' own titles end the same way, so strip it as often as it occurs.
function cleanTitle(title, publisher) {
    if (!title) return '';
    let t = title.trim();
    if (publisher) {
        const suffix = ` - ${publisher}`;
        let stripped = false;
        while (t.endsWith(suffix) && t.length > suffix.length + 3) {
            t = t.slice(0, -suffix.length).trim();
            stripped = true;
        }
        if (stripped) return t;
    }
    const dash = t.lastIndexOf(' - ');
    return dash > 10 ? t.slice(0, dash).trim() : t;
}

// Google's description is an HTML anchor with the headline and publisher (search feeds) or an
// ordered list of related coverage (topic feeds). Only text beyond those is a snippet.
function snippetFrom(description, title, publisher) {
    if (!description) return null;
    const text = stripTags(description.replace(/<ol>[\s\S]*<\/ol>/i, ''));
    const cleaned = text.replace(title, '').replace(publisher || '', '').replace(/\s+/g, ' ').trim();
    return cleaned.length >= 20 ? cleaned : null;
}

// ---------- URL decoding ----------

// Older ids embed the publisher URL after a short protobuf prefix; current ids (AU_yqL...) need Google's redirect service.
function directDecode(id) {
    try {
        const buf = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        let s = buf.toString('latin1');
        if (s.startsWith('\x08\x13"')) s = s.slice(3);
        if (s.endsWith('\xd2\x01\x00')) s = s.slice(0, -3);
        let len = s.charCodeAt(0);
        let start = 1;
        if (len >= 0x80) {
            len = (len - 0x80) + 0x80 * s.charCodeAt(1);
            start = 2;
        }
        const url = s.slice(start, start + len);
        if (/^https?:\/\/\S+$/.test(url) && !url.startsWith('AU_yqL')) return url;
    } catch { /* fall through */ }
    return null;
}

async function fetchDecodeParams(id, edition) {
    const res = await fetchText(`${RSS_BASE}/articles/${id}?${edition}`, { label: `article page ${id.slice(0, 16)}`, attempts: 2 });
    const sg = /data-n-a-sg="([^"]+)"/.exec(res.text)?.[1];
    const ts = /data-n-a-ts="([^"]+)"/.exec(res.text)?.[1];
    if (!sg || !ts) throw new Error(`no decoding signature on the redirect page (HTTP ${res.status}, ${res.text.length} bytes)`);
    return { sg, ts };
}

async function batchDecode(items) {
    const reqs = items.map((it, i) => {
        const payload = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], it.id, Number(it.ts), it.sg];
        return ['Fbv4je', JSON.stringify(payload), null, String(i + 1)];
    });
    const body = new URLSearchParams({ 'f.req': JSON.stringify([reqs]) }).toString();
    const res = await fetchText(BATCHEXECUTE, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, label: 'batchexecute' });
    const out = new Map();
    for (const line of res.text.split('\n')) {
        if (!line.startsWith('[[')) continue;
        let arr;
        try {
            arr = JSON.parse(line);
        } catch {
            continue;
        }
        for (const chunk of arr) {
            if (!Array.isArray(chunk) || chunk[0] !== 'wrb.fr' || chunk[1] !== 'Fbv4je') continue;
            const idx = Number(chunk[6]) - 1;
            let url = null;
            if (typeof chunk[2] === 'string') {
                try {
                    const inner = JSON.parse(chunk[2]);
                    if (inner?.[0] === 'garturlres' && /^https?:\/\//.test(inner[1] || '')) url = inner[1];
                } catch { /* error entry */ }
            }
            if (items[idx]) out.set(items[idx].id, url);
        }
    }
    return out;
}

async function decodeAll(ids, edition, stats, failures) {
    const result = new Map();
    const pending = [];
    for (const id of ids) {
        const direct = directDecode(id);
        if (direct) {
            result.set(id, direct);
            stats.decodeDirect++;
        } else pending.push(id);
    }
    const withParams = [];
    let i = 0;
    const workers = Array.from({ length: DECODE_CONCURRENCY }, async () => {
        while (i < pending.length) {
            const id = pending[i++];
            try {
                withParams.push({ id, ...(await fetchDecodeParams(id, edition)) });
            } catch (e) {
                stats.decodeFailed++;
                if (failures.length < 50) failures.push({ stage: 'redirect-page', id, error: e.message });
            }
        }
    });
    await Promise.all(workers);
    for (let j = 0; j < withParams.length; j += DECODE_BATCH) {
        const slice = withParams.slice(j, j + DECODE_BATCH);
        let decoded = new Map();
        try {
            decoded = await batchDecode(slice);
        } catch (e) {
            if (failures.length < 50) failures.push({ stage: 'batchexecute', ids: slice.length, error: e.message });
        }
        for (const it of slice) {
            const url = decoded.get(it.id) || null;
            if (url) result.set(it.id, url);
            else {
                stats.decodeFailed++;
                if (failures.length < 50 && !decoded.has(it.id)) failures.push({ stage: 'batchexecute', id: it.id, error: 'no result for this id' });
            }
        }
    }
    stats.decodeSucceeded = result.size;
    return result;
}

// ---------- canonical URLs ----------

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|cmpid|ncid|ocid|sr_share|guccounter|guce_referrer|guce_referrer_sig|smid|smtyp|taid|ref_src)$/i;
function canonicalUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        u.hostname = u.hostname.toLowerCase();
        for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
        let s = u.toString();
        if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
        if (u.pathname === '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
        return s;
    } catch {
        return url;
    }
}

// ---------- article text ----------

const BOILERPLATE = /\b(cookie|subscribe|subscription|sign up|sign in|log in|newsletter|advertisement|all rights reserved|read more|related articles?|share this|follow us|click here|terms of (use|service)|privacy policy)\b/i;

function detectCharset(contentType, head) {
    const ct = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
    if (ct) return ct;
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
    return meta || 'utf-8';
}

function decodeHtml(buffer, contentType) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    const charset = detectCharset(contentType, head).toLowerCase();
    try {
        return new TextDecoder(charset).decode(buffer);
    } catch {
        return buffer.toString('utf8');
    }
}

function metaContent(html, names) {
    for (const n of names) {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
        const m = re.exec(html);
        const v = m && (m[1] ?? m[2]);
        if (v) return decodeEntities(v).trim();
    }
    return null;
}

function jsonLdArticleBody(html) {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        const raw = m[1].trim();
        try {
            const data = JSON.parse(raw);
            const stack = [data];
            while (stack.length) {
                const node = stack.pop();
                if (Array.isArray(node)) stack.push(...node);
                else if (node && typeof node === 'object') {
                    if (typeof node.articleBody === 'string' && node.articleBody.length >= ARTICLE_TEXT_MIN_CHARS) return node.articleBody.replace(/\s+\n/g, '\n').trim();
                    for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'hasPart']) if (node[k]) stack.push(node[k]);
                }
            }
        } catch {
            const b = /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
            if (b) {
                try {
                    const s = JSON.parse(`"${b[1]}"`);
                    if (s.length >= ARTICLE_TEXT_MIN_CHARS) return s.trim();
                } catch { /* ignore */ }
            }
        }
    }
    return null;
}

function paragraphText(html) {
    let doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|aside|form|figure|figcaption|button)[\s>][\s\S]*?<\/\1>/gi, ' ');
    const regions = [];
    const articleRe = /<article[\s>][\s\S]*?<\/article>/gi;
    let m;
    while ((m = articleRe.exec(doc))) regions.push(m[0]);
    const bodyRe = /<[^>]+(?:itemprop=["']articleBody["']|class=["'][^"']*(?:article-body|articleBody|article__body|story-body|post-content|entry-content|content__body|article-content)[^"']*["'])[^>]*>([\s\S]*?)(?=<(?:footer|aside)[\s>]|$)/i;
    const b = bodyRe.exec(doc);
    if (b) regions.push(b[1]);
    if (regions.length === 0) regions.push(/<main[\s>][\s\S]*?<\/main>/i.exec(doc)?.[0] || doc);
    let best = '';
    for (const region of regions) {
        const paras = [];
        const pRe = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
        let p;
        while ((p = pRe.exec(region))) {
            const t = stripTags(p[1]);
            if (t.length < 25 || BOILERPLATE.test(t) && t.length < 120) continue;
            paras.push(t);
        }
        const text = paras.join('\n\n');
        if (text.length > best.length) best = text;
    }
    return best;
}

const hostLastAt = new Map();
async function fetchArticle(url) {
    const host = new URL(url).host;
    const wait = (hostLastAt.get(host) || 0) + ARTICLE_HOST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    hostLastAt.set(host, Date.now());
    let res;
    try {
        res = await fetchText(url, { timeoutMs: ARTICLE_TIMEOUT_MS, attempts: 1, maxBytes: ARTICLE_MAX_BYTES, label: `article ${host}`, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } });
    } catch (e) {
        return { status: /timeout/.test(e.message) ? 'timeout' : 'error', error: e.message };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 451) return { status: 'blocked', httpStatus: res.status };
    if (res.status >= 400) return { status: 'error', httpStatus: res.status, error: `HTTP ${res.status}` };
    if (!/html|xml/i.test(res.contentType)) return { status: 'not-html', contentType: res.contentType };
    const html = decodeHtml(res.text.buffer, res.contentType);
    const description = metaContent(html, ['og:description', 'description', 'twitter:description']);
    let text = jsonLdArticleBody(html);
    let method = 'json-ld';
    if (!text) {
        text = paragraphText(html);
        method = 'paragraphs';
    }
    if (text.length > ARTICLE_TEXT_MAX_CHARS) text = `${text.slice(0, ARTICLE_TEXT_MAX_CHARS)}…`;
    const paywalled = /"isAccessibleForFree"\s*:\s*(false|"False")/i.test(html);
    if (text.length < ARTICLE_TEXT_MIN_CHARS) return { status: paywalled ? 'paywall' : 'short', description, text: text || null, finalUrl: res.finalUrl };
    return { status: 'ok', text, description, method, finalUrl: res.finalUrl, httpStatus: res.status };
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
    const queries = cleanList(input.queries, 'queries');
    const topics = cleanList(input.topics, 'topics').map((t) => t.toUpperCase());
    const feedInputs = cleanList(input.feedUrls, 'feedUrls');
    const language = String(input.language ?? 'en-US').trim();
    const country = String(input.country ?? 'US').trim().toUpperCase();
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(language)) throw new InputError('language must be a code such as en, en-US, de, pt-BR, zh-CN.');
    if (!/^[A-Z]{2}$/.test(country)) throw new InputError('country must be a two-letter code such as US, GB, DE, IN, BR, JP, KR.');
    const ceid = String(input.ceid ?? '').trim() || deriveCeid(language, country);
    if (!/^[A-Z]{2}:[A-Za-z0-9-]+$/.test(ceid)) throw new InputError('ceid must look like US:en, DE:de or BR:pt-419.');
    for (const t of topics) if (!TOPICS.includes(t)) throw new InputError(`topics entry "${t}" is not valid. Use: ${TOPICS.join(', ')}.`);
    const maxResults = input.maxResults ?? 100;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);
    const publishedSince = parseSince(input.publishedSince);
    const decodeUrls = input.decodeUrls !== false;
    const fetchArticleTextFlag = Boolean(input.fetchArticleText);
    const edition = `hl=${encodeURIComponent(language)}&gl=${encodeURIComponent(country)}&ceid=${encodeURIComponent(ceid)}`;

    const feeds = [];
    const sinceDate = publishedSince ? publishedSince.toISOString().slice(0, 10) : null;
    for (const q of queries) {
        let query = q;
        if (sinceDate && !/\b(when|after|before):/i.test(q)) query = `${q} after:${sinceDate}`;
        feeds.push({ kind: 'query', label: q, url: `${RSS_BASE}/search?q=${encodeURIComponent(query)}&${edition}` });
    }
    for (const t of topics) feeds.push({ kind: 'topic', label: t, url: t === 'TOP' ? `${RSS_BASE}?${edition}` : `${RSS_BASE}/headlines/section/topic/${t}?${edition}` });
    for (const f of feedInputs) {
        const parsed = feedUrlFromInput(f, edition);
        feeds.push({ kind: 'feed', label: `${parsed.kind}/${parsed.id}`, url: parsed.url });
    }
    if (feeds.length === 0) throw new InputError('Provide at least one search query, topic or Google News feed URL.');
    if (feeds.length > MAX_FEEDS) throw new InputError(`At most ${MAX_FEEDS} queries, topics and feed URLs per run (got ${feeds.length}).`);

    const charger = await makeCharger();
    if ((await charger.charge('actor-start', 1)).limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');
    log.info(`Starting: ${queries.length} queries, ${topics.length} topics, ${feedInputs.length} feed URLs; edition ${language}/${country} (${ceid}); publishedSince=${publishedSince ? publishedSince.toISOString() : 'off'}, decodeUrls=${decodeUrls}, fetchArticleText=${fetchArticleTextFlag}`);

    const stats = { feeds: feeds.length, feedsFailed: 0, itemsSeen: 0, filteredByDate: 0, duplicateIds: 0, duplicateUrlsOrTitles: 0, decodeAttempted: 0, decodeDirect: 0, decodeSucceeded: 0, decodeFailed: 0, decodeSecs: 0, articleTextAttempted: 0, articleTextOk: 0, articleTextStatus: {}, articleTextSecs: 0, rowsPushed: 0, charged: {} };
    const failures = [];
    const perFeed = [];
    const now = new Date();

    // 1. Feeds.
    const items = [];
    const seenIds = new Set();
    for (const feed of feeds) {
        const entry = { kind: feed.kind, label: feed.label, url: feed.url, status: null, items: 0, kept: 0, error: null };
        perFeed.push(entry);
        try {
            const res = await fetchText(feed.url, { label: `${feed.kind} ${feed.label}`, headers: { accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' } });
            entry.status = res.status;
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            if (!/<rss|<feed/i.test(res.text.slice(0, 2000))) throw new Error(`not an RSS document (${res.contentType || 'unknown type'}); the edition or feed id may be invalid`);
            const parsed = parseFeed(res.text);
            // Google answers unknown ids with a 200 feed holding one placeholder item instead of an error.
            if (parsed.items.length === 1 && /^news:unfepa$/.test(parsed.items[0].guid || '')) throw new Error('Google reports "This feed is not available": the topic, section or publication id does not exist in this edition');
            entry.items = parsed.items.length;
            entry.title = parsed.channelTitle;
            stats.itemsSeen += parsed.items.length;
            let kept = 0;
            for (const it of parsed.items) {
                if (kept >= maxResults) break;
                const id = articleIdFromLink(it.link) || it.guid;
                if (!id || !it.title) continue;
                const published = it.pubDate ? new Date(it.pubDate) : null;
                const publishedAt = published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
                if (publishedSince && (!published || published < publishedSince)) {
                    stats.filteredByDate++;
                    continue;
                }
                if (seenIds.has(id)) {
                    stats.duplicateIds++;
                    continue;
                }
                seenIds.add(id);
                kept++;
                const title = cleanTitle(it.title, it.publisher);
                items.push({
                    id,
                    title,
                    publisher: it.publisher || null,
                    publisherUrl: it.publisherUrl || null,
                    googleUrl: it.link || `${RSS_BASE}/articles/${id}?oc=5`,
                    publishedAt,
                    snippet: snippetFrom(it.description, title, it.publisher),
                    query: feed.kind === 'query' ? feed.label : null,
                    topic: feed.kind === 'topic' ? feed.label : (feed.kind === 'feed' ? feed.label : null),
                    feedUrl: feed.url,
                });
            }
            entry.kept = kept;
            log.info(`${feed.kind} "${feed.label}": ${parsed.items.length} items, ${kept} kept`);
        } catch (e) {
            entry.error = e.message;
            stats.feedsFailed++;
            failures.push({ stage: 'feed', feed: feed.label, error: e.message });
            log.warning(`${feed.kind} "${feed.label}" failed: ${e.message}`);
        }
        await sleep(FEED_GAP_MS);
    }
    if (items.length === 0 && stats.feedsFailed === feeds.length) throw new Error(`Every feed failed: ${failures.map((f) => f.error).slice(0, 3).join('; ')}`);

    // 2. URL decoding.
    let decoded = new Map();
    if (decodeUrls && items.length) {
        const t0 = Date.now();
        stats.decodeAttempted = items.length;
        decoded = await decodeAll(items.map((it) => it.id), edition, stats, failures);
        stats.decodeSecs = Math.round((Date.now() - t0) / 100) / 10;
        log.info(`URL decoding: ${stats.decodeSucceeded}/${stats.decodeAttempted} resolved in ${stats.decodeSecs}s (${stats.decodeDirect} embedded, ${stats.decodeFailed} failed)`);
    }

    // 3. Rows with dedupe by canonical publisher URL and by title+publisher.
    const rows = [];
    const seenUrls = new Set();
    const seenTitles = new Set();
    for (const it of items) {
        const url = decoded.get(it.id) || null;
        const urlKey = url ? canonicalUrl(url) : null;
        const titleKey = `${normTitle(it.title)}|${(it.publisher || '').toLowerCase()}`;
        if ((urlKey && seenUrls.has(urlKey)) || seenTitles.has(titleKey)) {
            stats.duplicateUrlsOrTitles++;
            continue;
        }
        if (urlKey) seenUrls.add(urlKey);
        seenTitles.add(titleKey);
        rows.push({
            id: it.id,
            title: it.title,
            publisher: it.publisher,
            publisherUrl: it.publisherUrl,
            url: url || it.googleUrl,
            googleUrl: it.googleUrl,
            decoded: Boolean(url),
            publishedAt: it.publishedAt,
            snippet: it.snippet,
            query: it.query,
            topic: it.topic,
            feedUrl: it.feedUrl,
            language,
            country,
            ...(fetchArticleTextFlag ? { articleText: null, articleTextStatus: url ? 'pending' : 'no-publisher-url', articleTextChars: null } : {}),
            fetchedAt: now.toISOString(),
        });
    }

    // 4. Article text.
    if (fetchArticleTextFlag) {
        const t0 = Date.now();
        const targets = rows.filter((r) => r.decoded);
        stats.articleTextAttempted = targets.length;
        let i = 0;
        const workers = Array.from({ length: ARTICLE_CONCURRENCY }, async () => {
            while (i < targets.length) {
                const row = targets[i++];
                const r = await fetchArticle(row.url);
                row.articleTextStatus = r.status;
                stats.articleTextStatus[r.status] = (stats.articleTextStatus[r.status] || 0) + 1;
                if (r.status === 'ok') {
                    row.articleText = r.text;
                    row.articleTextChars = r.text.length;
                    stats.articleTextOk++;
                } else if (r.text) {
                    row.articleText = r.text;
                    row.articleTextChars = r.text.length;
                }
                if (!row.snippet && r.description) row.snippet = r.description;
            }
        });
        await Promise.all(workers);
        stats.articleTextSecs = Math.round((Date.now() - t0) / 100) / 10;
        log.info(`Article text: ${stats.articleTextOk}/${targets.length} extracted in ${stats.articleTextSecs}s; statuses ${JSON.stringify(stats.articleTextStatus)}`);
    }

    // 5. Charge and push.
    let stopReason = null;
    for (let j = 0; j < rows.length && !stopReason; j += PUSH_BATCH) {
        const batch = rows.slice(j, j + PUSH_BATCH);
        const art = await charger.charge('article', batch.length);
        const slice = batch.slice(0, art.allowed);
        if (fetchArticleTextFlag) {
            const withText = slice.filter((r) => r.articleTextStatus === 'ok');
            const txt = await charger.charge('article-text', withText.length);
            withText.slice(txt.allowed).forEach((r) => {
                r.articleText = null;
                r.articleTextChars = null;
                r.articleTextStatus = 'not-charged-limit';
            });
            if (txt.limitReached) stopReason = 'maximum charge reached (article-text)';
            stats.charged['article-text'] = (stats.charged['article-text'] || 0) + Math.min(txt.allowed, withText.length);
        }
        if (slice.length) {
            await Actor.pushData(slice);
            stats.rowsPushed += slice.length;
            stats.charged.article = (stats.charged.article || 0) + slice.length;
        }
        if (art.limitReached || art.allowed < batch.length) stopReason = 'maximum charge reached (article)';
    }

    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        edition: { language, country, ceid },
        input: { queries, topics, feedUrls: feedInputs, publishedSince: publishedSince ? publishedSince.toISOString() : null, maxResults, decodeUrls, fetchArticleText: fetchArticleTextFlag },
        stats,
        feeds: perFeed,
        failures,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.rowsPushed} rows from ${feeds.length - stats.feedsFailed}/${feeds.length} feeds; ${stats.decodeSucceeded}/${stats.decodeAttempted} URLs resolved; ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.rowsPushed} articles, ${stats.decodeSucceeded}/${stats.decodeAttempted} URLs resolved, ${stats.feedsFailed} feeds failed`);
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
