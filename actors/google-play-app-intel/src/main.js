import { Actor, log } from 'apify';
import gplay from 'google-play-scraper';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MIN_GAP_MS = 1000; // one request per second to play.google.com
const REQUEST_TIMEOUT_MS = 30000;
const MODES = ['detail', 'search', 'developer', 'chart'];
const COLLECTIONS = { TOP_FREE: gplay.collection.TOP_FREE, TOP_PAID: gplay.collection.TOP_PAID, GROSSING: gplay.collection.GROSSING };
const MAX_RESULTS_CAP = 500;

class InputError extends Error {}
class NotFoundError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- pacing and retries ----------

let lastRequestAt = 0;
async function pace() {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
}

async function withRetry(label, fn, attempts = 3) {
    for (let attempt = 1; ; attempt++) {
        try {
            await pace();
            return await fn();
        } catch (e) {
            const status = e?.status;
            if (status === 404 || /not found \(404\)/i.test(e?.message || '')) throw new NotFoundError(`${label}: not found on Google Play (404)`);
            if (attempt >= attempts) throw new Error(`${label}: ${e?.message || e} (after ${attempts} attempts)`);
            const delay = status === 429 ? 15000 * attempt : 2000 * attempt;
            log.warning(`${label}: ${e?.message || e} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
            await sleep(delay);
        }
    }
}

// Captures the HTML of the request the library makes, so the data-safety card can be parsed
// from the same response (the separate /store/apps/datasafety page is disallowed by robots.txt).
function requestCapture() {
    const box = { html: null };
    // Note: the library shallow-merges requestOptions over its own options, so a `headers` object here would
    // drop its Content-Type on POST endpoints (chart and pagination return HTTP 400). Set headers in a hook instead.
    const requestOptions = {
        timeout: { request: REQUEST_TIMEOUT_MS }, // the library sets no timeout; a stalled socket would otherwise hang the run
        retry: 0, // retries are handled by withRetry() so pacing is respected
        hooks: {
            beforeRequest: [(options) => {
                options.headers['user-agent'] = UA;
                options.headers['accept-language'] = 'en-US,en;q=0.9';
            }],
            afterResponse: [(response) => {
                if (typeof response.body === 'string' && response.body.includes('AF_initDataCallback')) box.html = response.body;
                return response;
            }],
        },
    };
    return { box, requestOptions };
}

// ---------- data-safety card (English store pages only) ----------

const DS_HEADLINES = [
    ['This app may share these data types with third parties', 'shared'],
    ['No data shared with third parties', 'noShared'],
    ['This app may collect these data types', 'collected'],
    ['No data collected', 'noCollected'],
    ['Data is encrypted in transit', 'encrypted'],
    ['Data isn\'t encrypted', 'notEncrypted'],
    ['You can request that data be deleted', 'deletable'],
    ['Data can\'t be deleted', 'notDeletable'],
    ['Committed to follow the Play Families Policy', 'families'],
    ['Independent security review', 'securityReview'],
];
const normalizeQuotes = (s) => s.replace(/[‘’ʼ]/g, '\'').replace(/\s+/g, ' ').trim();
const decodeEntities = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function parseDataSafety(html) {
    if (!html) return null;
    const anchor = html.indexOf('Safety starts with understanding');
    if (anchor < 0) return null;
    const slice = html.slice(anchor, anchor + 30000).replace(/<script[\s\S]*?<\/script>/g, '');
    const tokens = slice.split(/<[^>]+>/).map((t) => normalizeQuotes(decodeEntities(t))).filter(Boolean);
    const out = {
        sharesData: null,
        sharedDataTypes: null,
        collectsData: null,
        collectedDataTypes: null,
        encryptedInTransit: null,
        canRequestDeletion: null,
        independentSecurityReview: false,
        playFamiliesPolicy: false,
        summary: [],
    };
    const isHeadline = (t) => DS_HEADLINES.some(([h]) => t.startsWith(normalizeQuotes(h)));
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === 'See details') break;
        const match = DS_HEADLINES.find(([h]) => t.startsWith(normalizeQuotes(h)));
        if (!match) continue;
        const next = tokens[i + 1];
        const detail = next && !isHeadline(next) && next !== 'See details' && next.length < 400 ? next : null;
        out.summary.push(detail ? `${t}: ${detail}` : t);
        switch (match[1]) {
            case 'shared': out.sharesData = true; out.sharedDataTypes = detail; break;
            case 'noShared': out.sharesData = false; break;
            case 'collected': out.collectsData = true; out.collectedDataTypes = detail; break;
            case 'noCollected': out.collectsData = false; break;
            case 'encrypted': out.encryptedInTransit = true; break;
            case 'notEncrypted': out.encryptedInTransit = false; break;
            case 'deletable': out.canRequestDeletion = true; break;
            case 'notDeletable': out.canRequestDeletion = false; break;
            case 'families': out.playFamiliesPolicy = true; break;
            case 'securityReview': out.independentSecurityReview = true; break;
            default: break;
        }
    }
    return out.summary.length ? out : null;
}

// ---------- rows ----------

const round = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const isoFromMs = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

function detailRow(app, ctx, dataSafety) {
    const histogram = app.histogram || {};
    return {
        recordType: 'app',
        appId: app.appId,
        url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.appId)}&hl=${ctx.language}&gl=${ctx.country}`,
        title: app.title ?? null,
        summary: app.summary ?? null,
        description: app.description ?? null,
        developer: app.developer ?? null,
        developerId: app.developerId ?? null,
        developerEmail: app.developerEmail ?? null,
        developerWebsite: app.developerWebsite ?? null,
        developerAddress: app.developerAddress ?? null,
        genre: app.genre ?? null,
        genreId: app.genreId ?? null,
        categories: (app.categories || []).map((c) => c?.name).filter(Boolean),
        installsText: app.installs ?? null,
        minInstalls: app.minInstalls ?? null,
        maxInstalls: app.maxInstalls ?? null,
        score: round(app.score),
        scoreText: app.scoreText ?? null,
        ratingsCount: app.ratings ?? null,
        reviewsCount: app.reviews ?? null,
        histogram: { 1: histogram[1] ?? 0, 2: histogram[2] ?? 0, 3: histogram[3] ?? 0, 4: histogram[4] ?? 0, 5: histogram[5] ?? 0 },
        price: app.price ?? 0,
        originalPrice: app.originalPrice ?? null,
        currency: app.currency ?? null,
        priceText: app.priceText ?? null,
        free: app.free ?? (app.price === 0),
        offersIAP: Boolean(app.offersIAP),
        iapRange: app.IAPRange ?? null,
        adSupported: Boolean(app.adSupported),
        contentRating: app.contentRating ?? null,
        contentRatingDescription: app.contentRatingDescription ?? null,
        released: app.released ?? null,
        updated: isoFromMs(app.updated),
        version: app.version ?? null,
        androidVersion: app.androidVersionText ?? app.androidVersion ?? null,
        privacyPolicy: app.privacyPolicy ?? null,
        icon: app.icon ?? null,
        headerImage: app.headerImage ?? null,
        screenshotCount: (app.screenshots || []).length,
        hasVideo: Boolean(app.video),
        recentChanges: app.recentChanges ?? null,
        available: app.available ?? null,
        preregister: Boolean(app.preregister),
        playPass: Boolean(app.isAvailableInPlayPass),
        dataSafety,
        country: ctx.country,
        language: ctx.language,
        scrapedAt: new Date().toISOString(),
    };
}

function listRow(app, ctx, extra) {
    return {
        ...extra,
        appId: app.appId,
        url: app.url ?? `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.appId)}`,
        title: app.title ? decodeEntities(app.title) : null,
        summary: app.summary ? decodeEntities(app.summary) : null, // list endpoints return entity-encoded text
        developer: app.developer ?? null,
        developerId: app.developerId ?? null,
        score: round(app.score),
        scoreText: app.scoreText ?? null,
        price: app.price ?? 0,
        currency: app.currency ?? null,
        free: app.free ?? (app.price === 0),
        icon: app.icon ?? null,
        country: ctx.country,
        language: ctx.language,
        scrapedAt: new Date().toISOString(),
    };
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
        async charge(eventName, count = 1) {
            if (!enabled || count <= 0) return { allowed: count, limitReached: false };
            const result = await Actor.charge({ eventName, count });
            return { allowed: Math.min(count, result.chargedCount), limitReached: result.eventChargeLimitReached };
        },
    };
}

// ---------- input ----------

function parseAppId(value) {
    const s = String(value).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) {
        try {
            const id = new URL(s).searchParams.get('id');
            if (id) return id;
        } catch { /* fall through */ }
        throw new InputError(`"${s}" is not a Play Store app URL with an id= parameter.`);
    }
    if (!/^[A-Za-z0-9_.]+$/.test(s)) throw new InputError(`"${s}" is not a valid Android package name (letters, digits, dots and underscores).`);
    return s;
}

function cleanList(values, name) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new InputError(`${name} must be a list.`);
    return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

// ---------- main ----------

async function main() {
    const startedAt = Date.now();
    const input = (await Actor.getInput()) ?? {};
    const mode = input.mode ?? 'detail';
    if (!MODES.includes(mode)) throw new InputError(`mode must be one of ${MODES.join(', ')}.`);
    const country = String(input.country ?? 'us').trim().toLowerCase();
    const language = String(input.language ?? 'en').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(country)) throw new InputError('country must be a two-letter code such as us, gb, de, in, br.');
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) throw new InputError('language must be a code such as en, es, pt-br.');
    const maxResults = input.maxResults ?? 50;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);
    const fullDetail = Boolean(input.fullDetail);
    const includeDataSafety = input.includeDataSafety !== false;
    const ctx = { country, language };

    const appIds = cleanList(input.appIds, 'appIds').map(parseAppId).filter(Boolean);
    const searchTerms = cleanList(input.searchTerms, 'searchTerms');
    const developerIds = cleanList(input.developerIds, 'developerIds');
    if (mode === 'detail' && appIds.length === 0) throw new InputError('detail mode needs at least one entry in appIds (package name or Play Store URL).');
    if (mode === 'search' && searchTerms.length === 0) throw new InputError('search mode needs at least one entry in searchTerms.');
    if (mode === 'developer' && developerIds.length === 0) throw new InputError('developer mode needs at least one entry in developerIds (developer name as shown on Play, or numeric developer id).');
    let chartCategory = null;
    let chartCollection = null;
    if (mode === 'chart') {
        const cat = String(input.chartCategory ?? 'APPLICATION').trim().toUpperCase();
        const validCategories = Object.keys(gplay.category);
        if (!validCategories.includes(cat)) throw new InputError(`chartCategory "${cat}" is not valid. Use one of: ${validCategories.join(', ')}.`);
        chartCategory = cat;
        const col = String(input.chartCollection ?? 'TOP_FREE').trim().toUpperCase();
        if (!COLLECTIONS[col]) throw new InputError(`chartCollection must be one of ${Object.keys(COLLECTIONS).join(', ')}.`);
        chartCollection = col;
    }
    if (includeDataSafety && language !== 'en') log.warning('The data-safety summary is parsed from English store pages; with language != en the dataSafety field will be null.');

    const charger = await makeCharger();
    if ((await charger.charge('actor-start', 1)).limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    const stats = { mode, requests: 0, appsDetailed: 0, rowsPushed: 0, failed: 0, charged: {} };
    const failures = [];
    let stopReason = null;

    async function fetchDetail(appId) {
        const { box, requestOptions } = requestCapture();
        stats.requests++;
        const app = await withRetry(`detail ${appId}`, () => gplay.app({ appId, lang: language, country, throttle: 1, requestOptions }));
        const dataSafety = includeDataSafety ? parseDataSafety(box.html) : null;
        if (includeDataSafety && !dataSafety && language === 'en') log.debug(`No data-safety card found for ${appId}`);
        stats.appsDetailed++;
        return detailRow(app, ctx, dataSafety);
    }

    async function pushCharged(rows, eventName) {
        if (rows.length === 0 || stopReason) return;
        const { allowed, limitReached } = await charger.charge(eventName, rows.length);
        const slice = rows.slice(0, allowed);
        if (slice.length) {
            await Actor.pushData(slice);
            stats.rowsPushed += slice.length;
            stats.charged[eventName] = (stats.charged[eventName] || 0) + slice.length;
        }
        if (limitReached || allowed < rows.length) stopReason = `maximum charge reached (${eventName})`;
    }

    // Enrich light list rows with full details when requested; charges app-detail per app.
    async function detailRows(list, extraOf) {
        const out = [];
        for (const item of list) {
            if (stopReason) break;
            try {
                const row = await fetchDetail(item.appId);
                out.push({ ...extraOf(item), ...row });
            } catch (e) {
                stats.failed++;
                failures.push({ appId: item.appId, error: e.message });
                log.warning(e.message);
            }
        }
        return out;
    }

    if (mode === 'detail') {
        const ids = appIds.slice(0, maxResults);
        const batch = [];
        for (const appId of ids) {
            if (stopReason) break;
            try {
                batch.push(await fetchDetail(appId));
            } catch (e) {
                stats.failed++;
                failures.push({ appId, error: e.message });
                log.warning(e.message);
            }
            if (batch.length >= 20) await pushCharged(batch.splice(0), 'app-detail');
        }
        await pushCharged(batch, 'app-detail');
    } else if (mode === 'search') {
        for (const term of searchTerms) {
            if (stopReason) break;
            let list;
            try {
                stats.requests++;
                list = await withRetry(`search "${term}"`, () => gplay.search({ term, num: maxResults, lang: language, country, throttle: 1, requestOptions: requestCapture().requestOptions }));
            } catch (e) {
                stats.failed++;
                failures.push({ searchTerm: term, error: e.message });
                log.warning(e.message);
                continue;
            }
            list = list.slice(0, maxResults);
            log.info(`search "${term}": ${list.length} results`);
            const extraOf = (item) => ({ recordType: 'search', searchTerm: term, position: list.indexOf(item) + 1 });
            if (fullDetail) {
                const rows = await detailRows(list, extraOf);
                await pushCharged(rows, 'app-detail');
                await charger.charge('search-query', 1);
                stats.charged['search-query'] = (stats.charged['search-query'] || 0) + 1;
            } else {
                const rows = list.map((item) => listRow(item, ctx, extraOf(item)));
                const { limitReached } = await charger.charge('search-query', 1);
                stats.charged['search-query'] = (stats.charged['search-query'] || 0) + 1;
                if (limitReached) {
                    stopReason = 'maximum charge reached (search-query)';
                    break;
                }
                await Actor.pushData(rows);
                stats.rowsPushed += rows.length;
            }
        }
    } else if (mode === 'developer') {
        for (const devId of developerIds) {
            if (stopReason) break;
            let list;
            try {
                stats.requests++;
                list = await withRetry(`developer "${devId}"`, () => gplay.developer({ devId, num: maxResults, lang: language, country, throttle: 1, requestOptions: requestCapture().requestOptions }));
            } catch (e) {
                stats.failed++;
                failures.push({ developerId: devId, error: e.message });
                log.warning(e.message);
                continue;
            }
            list = list.slice(0, maxResults);
            log.info(`developer "${devId}": ${list.length} apps`);
            const extraOf = (item) => ({ recordType: 'developer', developerQuery: devId, position: list.indexOf(item) + 1 });
            if (fullDetail) {
                await pushCharged(await detailRows(list, extraOf), 'app-detail');
            } else {
                await pushCharged(list.map((item) => listRow(item, ctx, extraOf(item))), 'developer-app');
            }
        }
    } else if (mode === 'chart') {
        let list;
        try {
            stats.requests++;
            list = await withRetry(`chart ${chartCategory}/${chartCollection}`, () => gplay.list({
                category: gplay.category[chartCategory], collection: COLLECTIONS[chartCollection], num: maxResults, lang: language, country, throttle: 1, requestOptions: requestCapture().requestOptions,
            }));
        } catch (e) {
            stats.failed++;
            failures.push({ chart: `${chartCategory}/${chartCollection}`, error: e.message });
            throw new Error(`Chart ${chartCategory}/${chartCollection} for ${country}/${language} could not be loaded: ${e.message}`);
        }
        list = list.slice(0, maxResults);
        log.info(`chart ${chartCategory}/${chartCollection} (${country}): ${list.length} apps`);
        const snapshotAt = new Date().toISOString();
        const extraOf = (item) => ({ recordType: 'chart', chartCategory, chartCollection, rank: list.indexOf(item) + 1, snapshotAt });
        if (fullDetail) {
            await pushCharged(await detailRows(list, extraOf), 'app-detail');
        } else {
            await pushCharged(list.map((item) => listRow(item, ctx, extraOf(item))), 'chart-snapshot');
        }
    }

    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        input: { mode, country, language, maxResults, fullDetail, includeDataSafety, appIds: appIds.length, searchTerms, developerIds, chartCategory, chartCollection },
        stats,
        failures,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.rowsPushed} rows, ${stats.requests} page requests, ${stats.failed} failures; ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.rowsPushed} rows (${mode}), ${stats.failed} failures`);
    if (stats.rowsPushed === 0 && stats.failed > 0) {
        throw new Error(`Nothing could be fetched: ${failures.map((f) => f.error).slice(0, 3).join('; ')}`);
    }
}

await Actor.main(main);
