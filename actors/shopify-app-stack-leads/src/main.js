import { Actor, log } from 'apify';
import { APP_FINGERPRINTS, PLUS_HINTS, FREEMAIL_DOMAINS, ROLE_PREFIXES } from './fingerprints.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const CONCURRENCY = 3;
const HOST_GAP_MS = 500;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_STORES_CAP = 5000;
const PRODUCTS_PAGE_LIMIT = 250;
const PUSH_BATCH = 50;

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- http ----------

const hostLastRequest = new Map();
async function politeWait(host) {
    const wait = (hostLastRequest.get(host) || 0) + HOST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    hostLastRequest.set(host, Date.now());
}

async function httpGet(url, { accept, retries = 3 }) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        await politeWait(new URL(url).host);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
            });
            if ((res.status === 429 || res.status >= 500) && attempt < retries) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                await res.body?.cancel().catch(() => {});
                await sleep(retryAfter > 0 && retryAfter <= 60 ? retryAfter * 1000 : (res.status === 429 ? 5000 : 1500) * attempt);
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            return { status: res.status, text: buf.subarray(0, MAX_HTML_BYTES).toString('utf8'), finalUrl: res.url || url, headers: res.headers, bytes: buf.length };
        } catch (e) {
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`) : e;
            if (attempt < retries) await sleep(1500 * attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`GET ${url} failed after ${retries} attempts: ${lastError?.message}`);
}

async function getJsonMaybe(url) {
    try {
        const res = await httpGet(url, { accept: 'application/json,text/plain;q=0.9,*/*;q=0.8', retries: 2 });
        if (res.status !== 200) return { status: res.status, json: null };
        const trimmed = res.text.trimStart();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { status: res.status, json: null };
        return { status: res.status, json: JSON.parse(trimmed) };
    } catch (e) {
        return { status: null, json: null, error: e.message };
    }
}

// ---------- input ----------

function normalizeStores(input) {
    const raw = [];
    if (Array.isArray(input.storeUrls)) for (const e of input.storeUrls) raw.push(typeof e === 'string' ? e : e?.url);
    if (typeof input.storeList === 'string') for (const line of input.storeList.split(/[\r\n,;]+/)) raw.push(line);
    const out = [];
    const seen = new Set();
    for (let s of raw) {
        if (!s || typeof s !== 'string') continue;
        s = s.trim();
        if (!s || s.startsWith('#')) continue;
        if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
        let url;
        try {
            url = new URL(s);
        } catch {
            throw new InputError(`"${s}" is not a valid URL or domain.`);
        }
        if (!url.hostname.includes('.')) throw new InputError(`"${s}" is not a valid domain.`);
        const key = url.hostname.toLowerCase().replace(/^www\./, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(`${url.protocol}//${url.hostname}`);
    }
    return out;
}

// ---------- detection ----------

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

function parseShopifyGlobals(html) {
    const out = { theme: null, currency: null, shop: null, locale: null, country: null, moneyFormat: null };
    const theme = /Shopify\.theme\s*=\s*(\{[^}]*\})/.exec(html);
    if (theme) {
        try {
            out.theme = JSON.parse(theme[1]);
        } catch {
            const name = /"name"\s*:\s*"([^"]*)"/.exec(theme[1]);
            const schema = /"schema_name"\s*:\s*"([^"]*)"/.exec(theme[1]);
            const version = /"schema_version"\s*:\s*"([^"]*)"/.exec(theme[1]);
            const id = /"id"\s*:\s*(\d+)/.exec(theme[1]);
            const storeId = /"theme_store_id"\s*:\s*(\d+|null)/.exec(theme[1]);
            out.theme = { name: name?.[1] ?? null, schema_name: schema?.[1] ?? null, schema_version: version?.[1] ?? null, id: id ? Number(id[1]) : null, theme_store_id: storeId && storeId[1] !== 'null' ? Number(storeId[1]) : null };
        }
    }
    out.currency = /Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/.exec(html)?.[1] ?? null;
    out.shop = /Shopify\.shop\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
    out.locale = /Shopify\.locale\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
    out.country = /Shopify\.country\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
    out.moneyFormat = /Shopify\.money_format\s*=\s*"([^"]+)"/.exec(html)?.[1] ?? null;
    return out;
}

function scriptHosts(html, baseUrl) {
    const hosts = new Set();
    for (const m of html.matchAll(/<(?:script|link|iframe|img)[^>]+(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        try {
            const h = new URL(decodeEntities(m[1]), baseUrl).host.toLowerCase();
            if (h) hosts.add(h);
        } catch { /* ignore */ }
    }
    return [...hosts];
}

function detectApps(html, hosts) {
    const hostText = hosts.join('\n');
    const apps = [];
    for (const fp of APP_FINGERPRINTS) {
        const evidence = [];
        if (fp.hosts) for (const h of fp.hosts) if (hosts.some((x) => x === h || x.endsWith(`.${h}`))) evidence.push(`host:${h}`);
        if (evidence.length === 0 && fp.patterns) {
            for (const re of fp.patterns) {
                const m = re.exec(html) || re.exec(hostText);
                if (m) {
                    evidence.push(`html:${m[0].slice(0, 60)}`);
                    break;
                }
            }
        }
        if (evidence.length) apps.push({ app: fp.app, category: fp.category, evidence: evidence[0] });
    }
    return apps;
}

function detectPlusHints(html, hosts, meta) {
    const hints = [];
    for (const [label, re] of PLUS_HINTS) if (re.test(html)) hints.push(label);
    const regional = new Set((html.match(/https?:\/\/([a-z0-9-]+)\.myshopify\.com/gi) || []).map((s) => s.toLowerCase()));
    if (regional.size >= 3) hints.push(`multiple storefront domains (${regional.size} myshopify hosts)`);
    if (meta?.published_products_count >= 1000) hints.push('large catalogue (1000+ products)');
    if (hosts.some((h) => /^checkout\./.test(h))) hints.push('checkout subdomain');
    return hints;
}

function extractEmails(html, storeHost) {
    const found = new Set();
    for (const m of html.matchAll(/mailto:([^"'?\s<>\\]+)/gi)) found.add(decodeEntities(m[1]).trim().toLowerCase());
    for (const m of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) found.add(m[0].toLowerCase());
    const base = storeHost.replace(/^www\./, '');
    const baseRoot = base.split('.').slice(-2).join('.');
    const business = [];
    for (const e of found) {
        if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) continue;
        const [local, domain] = e.split('@');
        if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico)$/.test(domain)) continue;
        if (/sentry\.io|example\.com|shopify\.com|myshopify\.com|wixpress|schema\.org|w3\.org|yourdomain|domain\.com|email\.com|test\.com/.test(domain)) continue;
        if (/^[0-9a-f]{16,}$/.test(local) || /^(noreply|no-reply|donotreply|mailer-daemon|postmaster|abuse|unsubscribe|bounce)/.test(local)) continue;
        const role = ROLE_PREFIXES.some((p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}-`) || local.startsWith(`${p}_`) || local.startsWith(`${p}@`));
        const sameDomain = domain === base || domain === baseRoot || domain.endsWith(`.${baseRoot}`);
        const freemail = FREEMAIL_DOMAINS.has(domain);
        // Business contact only: role mailbox on any domain, or any mailbox on the store's own domain. Personal
        // mailboxes on freemail providers and named people on third-party domains are skipped.
        if (role || (sameDomain && !/^[a-z]+\.[a-z]+$/.test(local))) business.push({ email: e, sameDomain, role, freemail });
    }
    business.sort((a, b) => (b.sameDomain - a.sameDomain) || (b.role - a.role));
    return business;
}

function socialLinks(html) {
    const out = {};
    const nets = { instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})\/?/i, facebook: /https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.-]{2,60})\/?/i, tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i, youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9_.-]{2,60})/i, x: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})(?:[/"'?]|$)/i, pinterest: /https?:\/\/(?:www\.)?pinterest\.[a-z.]+\/([A-Za-z0-9_]{2,30})\/?/i, linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9_-]{2,60})/i };
    for (const [k, re] of Object.entries(nets)) {
        const m = re.exec(html);
        if (m && !/^(share|sharer|intent|plugins|p|reel|hashtag|explore|tr|dialog|embed|watch|pin|create)$/i.test(m[1])) out[k] = m[0].replace(/["'].*$/, '');
    }
    return Object.keys(out).length ? out : null;
}

function productStats(products) {
    if (!Array.isArray(products) || products.length === 0) return { count: 0, lastUpdated: null, lastCreated: null, vendors: [], productTypes: [], priceMin: null, priceMax: null, currencyGuess: null };
    let lastUpdated = null;
    let lastCreated = null;
    let priceMin = null;
    let priceMax = null;
    const vendors = new Map();
    const types = new Map();
    for (const p of products) {
        const u = p.updated_at ? new Date(p.updated_at) : null;
        const c = p.created_at ? new Date(p.created_at) : null;
        if (u && !Number.isNaN(u.getTime()) && (!lastUpdated || u > lastUpdated)) lastUpdated = u;
        if (c && !Number.isNaN(c.getTime()) && (!lastCreated || c > lastCreated)) lastCreated = c;
        if (p.vendor) vendors.set(p.vendor, (vendors.get(p.vendor) || 0) + 1);
        if (p.product_type) types.set(p.product_type, (types.get(p.product_type) || 0) + 1);
        for (const v of p.variants || []) {
            const price = Number(v.price);
            if (!Number.isFinite(price)) continue;
            priceMin = priceMin === null ? price : Math.min(priceMin, price);
            priceMax = priceMax === null ? price : Math.max(priceMax, price);
        }
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    return { count: products.length, lastUpdated: lastUpdated ? lastUpdated.toISOString() : null, lastCreated: lastCreated ? lastCreated.toISOString() : null, vendors: top(vendors), productTypes: top(types), priceMin, priceMax };
}

// ---------- per store ----------

async function analyzeStore(origin, opts) {
    const t0 = Date.now();
    const host = new URL(origin).host;
    const row = {
        storeUrl: origin,
        finalUrl: null,
        domain: host.replace(/^www\./, ''),
        httpStatus: null,
        isShopify: false,
        storefrontType: 'unknown',
        shopName: null,
        myshopifyDomain: null,
        shopId: null,
        themeName: null,
        themeSchemaName: null,
        themeSchemaVersion: null,
        themeStoreId: null,
        themeId: null,
        themeSource: null,
        currency: null,
        moneyFormat: null,
        locale: null,
        country: null,
        city: null,
        province: null,
        shipsToCountries: null,
        shopPayInstallments: null,
        productCount: null,
        productCountSource: null,
        collectionCount: null,
        lastProductUpdate: null,
        lastProductCreated: null,
        productsSampled: 0,
        priceMin: null,
        priceMax: null,
        topVendors: [],
        topProductTypes: [],
        apps: [],
        appNames: [],
        appCount: 0,
        appsByCategory: {},
        plusHints: [],
        likelyShopifyPlus: false,
        contactEmail: null,
        contactEmails: [],
        social: null,
        thirdPartyHosts: [],
        error: null,
        fetchedAt: new Date().toISOString(),
        durationMs: null,
    };
    try {
        const home = await httpGet(`${origin}/`, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' });
        row.httpStatus = home.status;
        row.finalUrl = home.finalUrl;
        if (home.status !== 200) {
            row.error = `homepage returned HTTP ${home.status}`;
            row.storefrontType = home.status === 403 || home.status === 429 ? 'blocked' : 'unavailable';
            return row;
        }
        const html = home.text;
        const finalOrigin = new URL(home.finalUrl).origin;
        const hosts = scriptHosts(html, home.finalUrl);
        const g = parseShopifyGlobals(html);
        const shopifyMarkers = /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme|shopify-section|x-shopify|cdn\/shop\/|Shopify\.routes|shopify-features/i.test(html) || /shopify/i.test(home.headers.get('powered-by') || '') || Boolean(home.headers.get('x-shopid'));
        row.isShopify = shopifyMarkers;
        row.shopId = home.headers.get('x-shopid') ? Number(home.headers.get('x-shopid')) : null;
        if (g.theme) {
            row.themeName = g.theme.name ?? null;
            row.themeSchemaName = g.theme.schema_name ?? null;
            row.themeSchemaVersion = g.theme.schema_version ?? null;
            row.themeStoreId = g.theme.theme_store_id ?? null;
            row.themeId = g.theme.id ?? null;
            row.themeSource = g.theme.theme_store_id ? 'theme-store' : 'custom';
        }
        row.currency = g.currency;
        row.moneyFormat = g.moneyFormat;
        row.locale = g.locale;
        row.country = g.country;
        row.myshopifyDomain = g.shop || (/https?:\/\/([a-z0-9-]+\.myshopify\.com)/i.exec(html)?.[1]?.toLowerCase() ?? null);
        if (!row.myshopifyDomain) {
            // Headless storefronts reference the shop only inside Storefront API URLs or config blobs.
            const bare = [...html.matchAll(/\b([a-z0-9][a-z0-9-]{1,60})\.myshopify\.com\b/gi)].map((m) => m[1].toLowerCase()).filter((s) => !/^(checkout|shop|www|admin|accounts|cdn|example|your-?store|yourshop|store-name|shop-name)$/.test(s));
            if (bare.length) row.myshopifyDomain = `${bare.sort((a, b) => bare.filter((x) => x === b).length - bare.filter((x) => x === a).length)[0]}.myshopify.com`;
        }

        // Store metadata and products from the storefront's public JSON endpoints.
        let meta = null;
        let products = null;
        let productsStatus = null;
        if (shopifyMarkers) {
            const m = await getJsonMaybe(`${finalOrigin}/meta.json`);
            if (m.json && typeof m.json === 'object' && (m.json.myshopify_domain || m.json.name)) meta = m.json;
            if (opts.fetchProducts) {
                const all = [];
                for (let page = 1; page <= opts.maxProductPages; page++) {
                    const p = await getJsonMaybe(`${finalOrigin}/products.json?limit=${PRODUCTS_PAGE_LIMIT}&page=${page}`);
                    if (page === 1) productsStatus = p.status;
                    if (!p.json || !Array.isArray(p.json.products)) break;
                    all.push(...p.json.products);
                    if (p.json.products.length < PRODUCTS_PAGE_LIMIT) break;
                }
                products = all;
            }
        }
        if (meta) {
            row.shopName = meta.name ?? null;
            row.myshopifyDomain = meta.myshopify_domain ?? row.myshopifyDomain;
            row.shopId = meta.id ?? row.shopId;
            row.currency = meta.currency ?? row.currency;
            row.moneyFormat = meta.money_format ?? row.moneyFormat;
            row.country = meta.country ?? row.country;
            row.city = meta.city ?? null;
            row.province = meta.province ?? null;
            row.shipsToCountries = Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries : null;
            row.shopPayInstallments = typeof meta.offers_shop_pay_installments === 'boolean' ? meta.offers_shop_pay_installments : null;
            if (typeof meta.published_products_count === 'number') {
                row.productCount = meta.published_products_count;
                row.productCountSource = 'meta.json';
            }
            if (typeof meta.published_collections_count === 'number') row.collectionCount = meta.published_collections_count;
        }
        if (!row.shopName) {
            const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i.exec(html);
            row.shopName = og ? decodeEntities(og[1]).trim() : (/<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim() ?? null);
        }
        if (products) {
            const ps = productStats(products);
            row.productsSampled = ps.count;
            row.lastProductUpdate = ps.lastUpdated;
            row.lastProductCreated = ps.lastCreated;
            row.priceMin = ps.priceMin;
            row.priceMax = ps.priceMax;
            row.topVendors = ps.vendors;
            row.topProductTypes = ps.productTypes;
            if (row.productCount === null) {
                row.productCount = ps.count;
                row.productCountSource = ps.count < opts.maxProductPages * PRODUCTS_PAGE_LIMIT ? 'products.json' : `products.json (first ${ps.count}, more exist)`;
            }
        }
        if (!shopifyMarkers) row.storefrontType = 'not-shopify';
        else if (g.theme) row.storefrontType = 'liquid';
        else if (meta || (products && products.length)) row.storefrontType = 'liquid-no-theme-object';
        else row.storefrontType = productsStatus && productsStatus !== 200 ? 'headless' : 'shopify-unknown';

        const apps = detectApps(html, hosts);
        row.apps = apps;
        row.appNames = apps.map((a) => a.app);
        row.appCount = apps.length;
        for (const a of apps) (row.appsByCategory[a.category] ||= []).push(a.app);
        row.plusHints = detectPlusHints(html, hosts, meta);
        row.likelyShopifyPlus = row.plusHints.some((h) => /launchpad|checkout\.liquid|shopify-plus|script editor|b2b|multiple storefront/i.test(h));
        if (opts.extractEmails) {
            const emails = extractEmails(html, host);
            row.contactEmails = emails.map((e) => e.email);
            row.contactEmail = emails[0]?.email ?? null;
        }
        row.social = socialLinks(html);
        row.thirdPartyHosts = hosts.filter((h) => !h.endsWith(row.domain) && !/shopify\.com$|shopifycdn\.com$|shop\.app$|^cdn\.shopify|fonts\.(googleapis|gstatic)\.com$/.test(h)).slice(0, 60);
        return row;
    } catch (e) {
        row.error = e.message;
        row.storefrontType = row.httpStatus ? row.storefrontType : 'unreachable';
        return row;
    } finally {
        row.durationMs = Date.now() - t0;
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
        maxStores = 1000,
        fetchProducts = true,
        maxProductPages = 1,
        extractEmails = true,
        onlyShopify = false,
    } = input;
    const stores = normalizeStores(input);
    if (stores.length === 0) throw new InputError('Provide at least one storefront in storeUrls (list) or storeList (one domain per line).');
    if (!Number.isInteger(maxStores) || maxStores < 1 || maxStores > MAX_STORES_CAP) throw new InputError(`maxStores must be an integer between 1 and ${MAX_STORES_CAP}.`);
    if (!Number.isInteger(maxProductPages) || maxProductPages < 0 || maxProductPages > 20) throw new InputError('maxProductPages must be an integer between 0 and 20.');
    const opts = { fetchProducts: Boolean(fetchProducts) && maxProductPages > 0, maxProductPages, extractEmails: Boolean(extractEmails) };
    const queue = stores.slice(0, maxStores);

    const charger = await makeCharger();
    const start = await charger.charge('actor-start', 1);
    if (start.limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');
    log.info(`Analysing ${queue.length} storefront(s) (${stores.length} given, maxStores=${maxStores}), concurrency ${CONCURRENCY}, ${HOST_GAP_MS} ms per host`);

    const stats = { storesGiven: stores.length, storesAttempted: 0, storesAnalyzed: 0, shopifyStores: 0, nonShopify: 0, failed: 0, emailsFound: 0 };
    const failures = [];
    const appTotals = new Map();
    let pending = [];
    let stopReason = null;
    let chargeLimitReached = false;
    let flushing = Promise.resolve();

    function flush(final = false) {
        flushing = flushing.then(async () => {
            while (!chargeLimitReached && (pending.length >= PUSH_BATCH || (final && pending.length > 0))) {
                const batch = pending.splice(0, PUSH_BATCH);
                const billable = batch.filter((r) => !r.error);
                const charged = await charger.charge('store-analyzed', billable.length);
                let allowedBillable = charged.allowed;
                const rows = [];
                for (const r of batch) {
                    if (r.error) rows.push(r);
                    else if (allowedBillable > 0) {
                        rows.push(r);
                        allowedBillable--;
                    }
                }
                if (rows.length) await Actor.pushData(rows);
                stats.storesAnalyzed += rows.filter((r) => !r.error).length;
                if (charged.limitReached || charged.allowed < billable.length) {
                    chargeLimitReached = true;
                    stopReason = 'maximum charge reached (store-analyzed)';
                }
            }
        });
        return flushing;
    }

    let next = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (!stopReason && next < queue.length) {
            const origin = queue[next++];
            stats.storesAttempted++;
            const row = await analyzeStore(origin, opts);
            if (row.error) {
                stats.failed++;
                failures.push({ storeUrl: origin, error: row.error, httpStatus: row.httpStatus });
                log.warning(`${origin}: ${row.error}`);
            } else {
                if (row.isShopify) stats.shopifyStores++;
                else stats.nonShopify++;
                if (row.contactEmail) stats.emailsFound++;
                for (const a of row.appNames) appTotals.set(a, (appTotals.get(a) || 0) + 1);
                log.info(`${origin}: ${row.storefrontType}, theme=${row.themeSchemaName || row.themeName || '-'}, apps=${row.appNames.join(',') || '-'}, products=${row.productCount ?? '-'}, email=${row.contactEmail || '-'} (${row.durationMs} ms)`);
            }
            if (row.error && (onlyShopify || row.httpStatus === null)) {
                // Unreachable stores are still recorded (free) so the buyer can see which inputs failed.
            }
            if (!row.error && onlyShopify && !row.isShopify) continue;
            pending.push(row);
            await flush();
        }
    });
    await Promise.all(workers);
    await flush(true);

    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        stats,
        appTotals: [...appTotals.entries()].sort((a, b) => b[1] - a[1]).map(([app, stores]) => ({ app, stores })),
        failures,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.storesAnalyzed} stores analysed (${stats.shopifyStores} Shopify, ${stats.nonShopify} not Shopify, ${stats.failed} failed); stop reason: ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.storesAnalyzed} stores analysed, ${stats.failed} failed (${summary.stopReason})`);
    if (stats.storesAnalyzed === 0 && stats.failed > 0) throw new Error(`Every storefront failed (${stats.failed}); see SUMMARY in the key-value store.`);
}

await Actor.main(main);
