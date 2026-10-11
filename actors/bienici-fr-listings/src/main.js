import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://www.bienici.com/realEstateAds.json';
const SUGGEST_URL = 'https://res.bienici.com/suggest.json';
const MIN_GAP_MS = 1000; // one request per second to bienici.com
const REQUEST_TIMEOUT_MS = 45000;
const MAX_RESULTS_CAP = 5000;
const MAX_PAGE_SIZE = 200;
const PUSH_BATCH = 200;
const PROPERTY_TYPES = ['flat', 'house', 'parkingbox', 'terrain', 'loft', 'shop', 'building', 'castle', 'premises', 'office', 'townhouse', 'programme', 'others'];
const SORT_FIELDS = ['relevance', 'publicationDate', 'price', 'surfaceArea', 'pricePerSquareMeter'];
const ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const ZONE_TYPE_PRIORITY = ['city', 'arrondissement', 'department', 'region', 'district', 'neighbourhood', 'postalcode'];

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- pacing and retries ----------

let lastRequestAt = 0;
async function pace() {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
}

async function getJson(url, label, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await pace();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'user-agent': UA,
                    accept: 'application/json, text/plain, */*',
                    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
                    referer: 'https://www.bienici.com/',
                },
            });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 15000 : 3000) * attempt;
                log.warning(`${label}: HTTP ${res.status} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                await sleep(delay);
                continue;
            }
            if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`${label}: response is not JSON (starts with "${text.slice(0, 80).replace(/\s+/g, ' ')}")`);
            }
        } catch (e) {
            if (e.name === 'AbortError') lastError = new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`);
            else if (/^.*: HTTP \d+|not JSON/.test(e.message)) throw e;
            else lastError = e;
            if (attempt < attempts) {
                log.warning(`${label}: ${lastError.message} (attempt ${attempt}/${attempts}); retrying`);
                await sleep(3000 * attempt);
            }
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${label}: failed after ${attempts} attempts (${lastError?.message})`);
}

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
    if (Number.isNaN(d.getTime())) throw new InputError(`publishedSince "${value}" is not an ISO date (2026-10-01) or a relative period such as 24h, 7d, 2w, 1m.`);
    return d;
}

function optionalNumber(value, name, { min = 0, integer = false } = {}) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
        throw new InputError(`${name} must be a ${integer ? 'whole ' : ''}number >= ${min}, got ${JSON.stringify(value)}.`);
    }
    return n;
}

function validateEnumList(values, allowed, name) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new InputError(`${name} must be an array.`);
    const out = [];
    for (const v of values) {
        const s = String(v).trim();
        if (!s) continue;
        const hit = allowed.find((a) => a.toLowerCase() === s.toLowerCase());
        if (!hit) throw new InputError(`${name} contains "${v}"; allowed values are ${allowed.join(', ')}.`);
        if (!out.includes(hit)) out.push(hit);
    }
    return out;
}

// ---------- zones ----------

async function resolveZones(locations) {
    const zoneIds = [];
    const resolved = [];
    for (const raw of locations) {
        const q = String(raw).trim();
        if (!q) continue;
        if (/^-?\d+$/.test(q) && q.startsWith('-')) {
            zoneIds.push(q);
            resolved.push({ query: q, name: q, type: 'zoneId', zoneIds: [q] });
            continue;
        }
        const suggestions = await getJson(`${SUGGEST_URL}?q=${encodeURIComponent(q)}`, `suggest "${q}"`);
        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            throw new InputError(`Location "${q}" was not found on Bien'ici. Use a French city name (Lyon), an arrondissement (Paris 11e), a postcode (69003) or a department (Rhône).`);
        }
        // Exact name or postcode match first, then the site's own ranking. The suggester fuzzy-matches anything
        // (a nonsense query returns villages with a score around 0.00002), so a weak best match is rejected.
        const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const fq = fold(q);
        const exact = suggestions.find((s) => fold(s.name) === fq || (s.postalCodes || []).includes(q) || s.insee_code === q);
        const pick = exact || suggestions.slice().sort((a, b) => {
            const pa = ZONE_TYPE_PRIORITY.indexOf(a.type);
            const pb = ZONE_TYPE_PRIORITY.indexOf(b.type);
            return (b.score || 0) - (a.score || 0) || (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        })[0];
        const plausible = exact || (pick.score || 0) >= 1 || fold(pick.name).startsWith(fq) || fold(pick.name).includes(fq);
        if (!plausible) {
            throw new InputError(`Location "${q}" was not found on Bien'ici (closest suggestion "${pick.name}" is a weak fuzzy match). Use a French city name (Lyon), an arrondissement (Paris 11e), a postcode (69003) or a department (Rhône).`);
        }
        if (!pick?.zoneIds?.length) throw new InputError(`Location "${q}" matched "${pick?.name}" but it has no searchable zone on Bien'ici.`);
        for (const id of pick.zoneIds) if (!zoneIds.includes(id)) zoneIds.push(id);
        resolved.push({ query: q, name: pick.name, type: pick.type, postalCodes: pick.postalCodes || [], insee: pick.insee_code || null, zoneIds: pick.zoneIds });
        log.info(`Location "${q}" -> ${pick.name} (${pick.type}, zone ${pick.zoneIds.join(',')})`);
    }
    return { zoneIds, resolved };
}

// ---------- rows ----------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v)));
const bool = (v) => (v === true ? true : v === false ? false : null);
const str = (v) => (v === null || v === undefined ? null : String(v));
// The feed uses the Unix epoch as "unknown" for a few imported ads.
const isoDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 ? null : d.toISOString();
};

const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const PROPERTY_SLUG = { flat: 'appartement', house: 'maison', parkingbox: 'parking', terrain: 'terrain', loft: 'loft', shop: 'commerce', building: 'immeuble', castle: 'chateau', premises: 'local', office: 'bureau', townhouse: 'maison', programme: 'programme', others: 'bien' };

function listingUrl(ad) {
    const tx = ad.adType === 'rent' ? 'location' : 'vente';
    const city = slugify(ad.city) || 'france';
    const type = PROPERTY_SLUG[ad.propertyType] || slugify(ad.propertyType) || 'bien';
    const rooms = Number.isInteger(ad.roomsQuantity) && ad.roomsQuantity > 0 ? `/${ad.roomsQuantity}pieces` : '';
    return `https://www.bienici.com/annonce/${tx}/${city}/${type}${rooms}/${encodeURIComponent(ad.id)}`;
}

function toRow(ad, { includeDescription, includePhotos }) {
    const pos = ad.blurInfo?.position || ad.blurInfo?.centroid || null;
    const photos = Array.isArray(ad.photos) ? ad.photos : [];
    const history = ad.priceHistory ?? ad.priceDecreases ?? ad.priceEvolution ?? null;
    return {
        id: ad.id,
        url: listingUrl(ad),
        transactionType: ad.adType === 'rent' ? 'rent' : 'sale',
        propertyType: str(ad.propertyType),
        propertySubtype: str(ad.propertySubtype),
        title: str(ad.title),
        price: num(ad.price),
        priceWithoutFees: num(ad.priceWithoutFees),
        pricePerSquareMeter: num(ad.pricePerSquareMeter) !== null ? Math.round(num(ad.pricePerSquareMeter)) : null,
        priceHasDecreased: bool(ad.priceHasDecreased),
        priceHistory: Array.isArray(history) && history.length ? history : null,
        feesChargedTo: str(ad.feesChargedTo),
        agencyFeePercentage: num(ad.agencyFeePercentage),
        annualCondominiumFees: num(ad.annualCondominiumFees),
        surface: num(ad.surfaceArea),
        landSurface: num(ad.landSurfaceArea),
        rooms: num(ad.roomsQuantity),
        bedrooms: num(ad.bedroomsQuantity),
        bathrooms: num(ad.bathroomsQuantity),
        floor: num(ad.floor),
        floorCount: num(ad.floorQuantity),
        energyClass: ENERGY_CLASSES.includes(ad.energyClassification) ? ad.energyClassification : null,
        energyValue: num(ad.energyValue),
        ghgClass: ENERGY_CLASSES.includes(ad.greenhouseGazClassification) ? ad.greenhouseGazClassification : null,
        ghgValue: num(ad.greenhouseGazValue),
        heating: str(ad.heating),
        city: str(ad.city),
        postalCode: str(ad.postalCode),
        departmentCode: str(ad.departmentCode),
        district: str(ad.district?.libelle || ad.district?.name),
        lat: num(pos?.lat),
        lon: num(pos?.lon),
        locationPrecisionMeters: num(ad.blurInfo?.radius),
        addressKnown: bool(ad.addressKnown),
        publicationDate: isoDate(ad.publicationDate),
        modificationDate: isoDate(ad.modificationDate),
        availableDate: isoDate(ad.availableDate),
        isNewBuild: bool(ad.newProperty),
        isProfessional: bool(ad.adCreatedByPro),
        accountType: str(ad.accountType),
        advertiserName: str(ad.accountDisplayName),
        advertiserAccountId: str(ad.userRelativeData?.accountIds?.[0]),
        isExclusiveMandate: bool(ad.isExclusiveSaleMandate),
        isBienIciExclusive: bool(ad.isBienIciExclusive),
        hasTerrace: bool(ad.hasTerrace),
        hasBalcony: bool(ad.hasBalcony),
        hasGarden: bool(ad.hasGarden),
        hasCellar: bool(ad.hasCellar),
        hasPool: bool(ad.hasPool),
        hasElevator: bool(ad.hasElevator),
        parkingPlaces: num(ad.parkingPlacesQuantity),
        isInCondominium: bool(ad.isInCondominium),
        workToDo: bool(ad.workToDo),
        opticalFiberStatus: str(ad.opticalFiberStatus),
        reference: str(ad.reference),
        photoCount: photos.length,
        photos: includePhotos ? photos.map((p) => p?.url || p?.url_photo).filter(Boolean) : undefined,
        description: includeDescription ? str(ad.description) : undefined,
        virtualTourCount: Array.isArray(ad.virtualTours) ? ad.virtualTours.length : 0,
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
        transactionType = 'buy',
        locations = [],
        maxResults = 300,
        sortBy = 'publicationDate',
        sortOrder = 'desc',
        newBuild = 'any',
        includeDescription = true,
        includePhotos = false,
        pageSize = 100,
        extraFilters = {},
    } = input;

    const filterType = { buy: 'buy', sale: 'buy', rent: 'rent' }[String(transactionType).toLowerCase()];
    if (!filterType) throw new InputError(`transactionType must be "buy" or "rent", got ${JSON.stringify(transactionType)}.`);
    if (!Array.isArray(locations)) throw new InputError('locations must be an array of strings (city, postcode, department or zone id).');
    const propertyTypes = validateEnumList(input.propertyTypes ?? ['flat', 'house'], PROPERTY_TYPES, 'propertyTypes');
    if (propertyTypes.length === 0) throw new InputError(`propertyTypes must contain at least one of ${PROPERTY_TYPES.join(', ')}.`);
    const energyClasses = validateEnumList(input.energyClasses, ENERGY_CLASSES, 'energyClasses');
    const minPrice = optionalNumber(input.minPrice, 'minPrice');
    const maxPrice = optionalNumber(input.maxPrice, 'maxPrice');
    const minSurface = optionalNumber(input.minSurface, 'minSurface');
    const maxSurface = optionalNumber(input.maxSurface, 'maxSurface');
    const minRooms = optionalNumber(input.minRooms, 'minRooms', { integer: true });
    const maxRooms = optionalNumber(input.maxRooms, 'maxRooms', { integer: true });
    const minBedrooms = optionalNumber(input.minBedrooms, 'minBedrooms', { integer: true });
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) throw new InputError('minPrice is greater than maxPrice.');
    if (minSurface !== undefined && maxSurface !== undefined && minSurface > maxSurface) throw new InputError('minSurface is greater than maxSurface.');
    if (minRooms !== undefined && maxRooms !== undefined && minRooms > maxRooms) throw new InputError('minRooms is greater than maxRooms.');
    const publishedSince = parseSince(input.publishedSince);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);
    if (!SORT_FIELDS.includes(sortBy)) throw new InputError(`sortBy must be one of ${SORT_FIELDS.join(', ')}.`);
    if (!['asc', 'desc'].includes(sortOrder)) throw new InputError('sortOrder must be "asc" or "desc".');
    if (!['any', 'only', 'exclude'].includes(newBuild)) throw new InputError('newBuild must be "any", "only" or "exclude".');
    const size = Math.min(Math.max(Number(pageSize) || 100, 10), MAX_PAGE_SIZE);
    if (extraFilters && typeof extraFilters !== 'object') throw new InputError('extraFilters must be a JSON object of raw Bien\'ici filter keys.');

    const charger = await makeCharger();
    const start = await charger.charge('actor-start', 1);
    if (start.limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    const { zoneIds, resolved } = await resolveZones(locations);

    const baseFilters = {
        size,
        from: 0,
        page: 1,
        showAllModels: false,
        filterType,
        propertyType: propertyTypes,
        sortBy,
        sortOrder,
        onTheMarket: [true],
    };
    if (zoneIds.length) baseFilters.zoneIdsByTypes = { zoneIds };
    if (minPrice !== undefined) baseFilters.minPrice = minPrice;
    if (maxPrice !== undefined) baseFilters.maxPrice = maxPrice;
    if (minSurface !== undefined) baseFilters.minArea = minSurface;
    if (maxSurface !== undefined) baseFilters.maxArea = maxSurface;
    if (minRooms !== undefined) baseFilters.minRooms = minRooms;
    if (maxRooms !== undefined) baseFilters.maxRooms = maxRooms;
    if (minBedrooms !== undefined) baseFilters.minBedrooms = minBedrooms;
    if (energyClasses.length) baseFilters.energyClassification = energyClasses;
    if (newBuild === 'only') baseFilters.newProperty = true;
    if (newBuild === 'exclude') baseFilters.newProperty = false;
    Object.assign(baseFilters, extraFilters || {});

    log.info(`Searching Bien'ici: ${filterType} ${propertyTypes.join('/')} in ${resolved.map((r) => r.name).join(', ') || 'all of France'}; maxResults=${maxResults}, pageSize=${size}, publishedSince=${publishedSince ? publishedSince.toISOString() : 'off'}`);

    const stats = { requests: 0, pagesFetched: 0, adsSeen: 0, duplicates: 0, skippedOtherTypes: 0, filteredByDate: 0, listingsPushed: 0, totalMatching: null };
    const wantedTypes = new Set(propertyTypes);
    const seen = new Set();
    let pending = [];
    let stopReason = null;
    let chargeLimitReached = false;

    async function flush(final = false) {
        while (!chargeLimitReached && (pending.length >= PUSH_BATCH || (final && pending.length > 0))) {
            const batch = pending.splice(0, PUSH_BATCH);
            const listed = await charger.charge('listing', batch.length);
            const rows = batch.slice(0, listed.allowed);
            if (rows.length) {
                await Actor.pushData(rows);
                stats.listingsPushed += rows.length;
            }
            if (listed.limitReached || rows.length < batch.length) {
                chargeLimitReached = true;
                stopReason = 'maximum charge reached (listing)';
            }
        }
    }

    let from = 0;
    let page = 1;
    let listedSoFar = 0;
    while (!stopReason) {
        const filters = { ...baseFilters, from, page, size: Math.min(size, maxResults - listedSoFar) };
        const url = `${SEARCH_URL}?filters=${encodeURIComponent(JSON.stringify(filters))}`;
        stats.requests++;
        const data = await getJson(url, `search page ${page}`);
        stats.pagesFetched++;
        const ads = Array.isArray(data.realEstateAds) ? data.realEstateAds : [];
        if (stats.totalMatching === null) {
            stats.totalMatching = num(data.total);
            log.info(`Bien'ici reports ${stats.totalMatching ?? '?'} matching listings`);
        }
        if (ads.length === 0) {
            stopReason = page === 1 ? 'no listings match the filters' : 'all matching listings fetched';
            break;
        }
        let olderSeen = 0;
        for (const ad of ads) {
            stats.adsSeen++;
            if (!ad?.id || seen.has(ad.id)) {
                stats.duplicates++;
                continue;
            }
            // The site mixes new-build programme lots into flat/house searches; only keep the types asked for.
            if (ad.propertyType && !wantedTypes.has(ad.propertyType)) {
                stats.skippedOtherTypes++;
                continue;
            }
            if (publishedSince) {
                const pubIso = isoDate(ad.publicationDate);
                const pub = pubIso ? new Date(pubIso) : null;
                if (!pub || pub < publishedSince) {
                    stats.filteredByDate++;
                    olderSeen++;
                    continue;
                }
            }
            if (listedSoFar >= maxResults) {
                stopReason = `maxResults (${maxResults}) reached`;
                break;
            }
            seen.add(ad.id);
            pending.push(toRow(ad, { includeDescription, includePhotos }));
            listedSoFar++;
        }
        await flush();
        if (stopReason) break;
        if (listedSoFar >= maxResults) {
            stopReason = `maxResults (${maxResults}) reached`;
            break;
        }
        // When sorted by publication date descending, a full page of older ads means the rest is older too.
        if (publishedSince && sortBy === 'publicationDate' && sortOrder === 'desc' && olderSeen === ads.length) {
            stopReason = 'reached listings older than publishedSince';
            break;
        }
        if (ads.length < filters.size || (stats.totalMatching !== null && from + ads.length >= stats.totalMatching)) {
            stopReason = 'all matching listings fetched';
            break;
        }
        from += ads.length;
        page++;
    }
    await flush(true);

    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        transactionType: filterType,
        propertyTypes,
        locations: resolved,
        filters: { ...baseFilters, size: undefined, from: undefined, page: undefined },
        publishedSince: publishedSince ? publishedSince.toISOString() : null,
        stats,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.listingsPushed} listings from ${stats.pagesFetched} pages (site total ${stats.totalMatching}); stop reason: ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.listingsPushed} listings (${summary.stopReason})`);
}

await Actor.main(async () => {
    try {
        await main();
    } catch (e) {
        // Let keep-alive sockets from the last fetch settle before the SDK exits the process; without this,
        // Node 24 on Windows can abort with a libuv assertion instead of the intended exit code.
        await sleep(300);
        throw e;
    }
});
