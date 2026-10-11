import { Actor, log } from 'apify';
import { resolveStation, STATIONS } from './stations.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const NWS = 'https://api.weather.gov';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const GAP_MS = { kalshi: 200, nws: 300, 'open-meteo': 250 }; // polite per-host pacing
const REQUEST_TIMEOUT_MS = 30000;
const MAX_MARKETS_CAP = 5000;
const OPEN_METEO_DAYS = 14;
const KINDS = { KXHIGH: 'high', KXLOW: 'low', KXRAIN: 'rain' };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- http ----------

const lastAt = new Map();
async function politeWait(bucket) {
    const wait = (lastAt.get(bucket) || 0) + (GAP_MS[bucket] || 250) - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(bucket, Date.now());
}

async function getJson(bucket, url, { attempts = 3, accept = 'application/json' } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await politeWait(bucket);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept } });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 5000 : 2000) * attempt;
                if (attempt < attempts) {
                    log.warning(`${bucket} ${res.status} on ${url.slice(0, 100)} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                    await sleep(delay);
                }
                continue;
            }
            if (res.status === 404) return null;
            if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url.slice(0, 120)}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
            return JSON.parse(text);
        } catch (e) {
            if (/^HTTP \d+ from/.test(e.message)) throw e;
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`) : e;
            if (attempt < attempts) await sleep(2000 * attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${bucket}: ${url.slice(0, 120)} failed after ${attempts} attempts (${lastError?.message})`);
}

// ---------- maths ----------

// Standard normal CDF (Abramowitz-Stegun 7.1.26, max error 1.5e-7).
function normCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-z * z);
    return 0.5 * (1 + (z < 0 ? -erf : erf));
}
const round = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const fToC = (f) => (f - 32) * 5 / 9;
const cToF = (c) => c * 9 / 5 + 32;
const mean = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// ---------- dates ----------

const dateFmtCache = new Map();
function localDate(date, tz) {
    if (!dateFmtCache.has(tz)) dateFmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
    return dateFmtCache.get(tz).format(date); // YYYY-MM-DD
}
function daysBetween(fromYmd, toYmd) {
    return Math.round((Date.UTC(...toYmd.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v))) - Date.UTC(...fromYmd.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)))) / 86400e3);
}
function parseTickerDate(ticker) {
    const m = /-(\d{2})([A-Z]{3})(\d{2})(?:-|$)/.exec(ticker);
    if (!m || !MONTHS[m[2]]) return null;
    return `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[3]}`;
}
function isoDurationMs(s) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s || '');
    if (!m) return 0;
    return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600e3 + Number(m[3] || 0) * 60e3;
}

// ---------- forecasts ----------

// NWS gridpoint raw data: values carry a UTC start and an ISO duration; the local date of the interval midpoint is
// the calendar day the value belongs to (a daily minimum spans the previous evening to the next morning).
function nwsSeriesByDate(values, tz, reducer) {
    const out = new Map();
    for (const v of values || []) {
        if (v.value === null || v.value === undefined) continue;
        const [start, dur] = String(v.validTime).split('/');
        const t0 = new Date(start).getTime();
        const mid = new Date(t0 + isoDurationMs(dur) / 2);
        const d = localDate(mid, tz);
        out.set(d, out.has(d) ? reducer(out.get(d), v.value) : v.value);
    }
    return out;
}

async function fetchNws(st) {
    const points = await getJson('nws', `${NWS}/points/${st.lat.toFixed(4)},${st.lon.toFixed(4)}`, { accept: 'application/geo+json' });
    const gridUrl = points?.properties?.forecastGridData;
    if (!gridUrl) throw new Error('NWS points response has no forecastGridData');
    const grid = await getJson('nws', gridUrl, { accept: 'application/geo+json' });
    const p = grid?.properties || {};
    const cToFMaybe = (uom) => (String(uom || '').includes('degC') ? cToF : (x) => x);
    const tmax = cToFMaybe(p.maxTemperature?.uom);
    const tmin = cToFMaybe(p.minTemperature?.uom);
    const highs = nwsSeriesByDate(p.maxTemperature?.values, st.tz, Math.max);
    const lows = nwsSeriesByDate(p.minTemperature?.values, st.tz, Math.min);
    const pops = nwsSeriesByDate(p.probabilityOfPrecipitation?.values, st.tz, Math.max);
    const qpf = nwsSeriesByDate(p.quantitativePrecipitation?.values, st.tz, (a, b) => a + b);
    const mmToIn = String(p.quantitativePrecipitation?.uom || '').includes('mm') ? (x) => x / 25.4 : (x) => x;
    return {
        source: 'nws',
        office: points.properties.gridId,
        grid: `${points.properties.gridX},${points.properties.gridY}`,
        updated: p.updateTime || null,
        byDate: (d) => ({
            high: highs.has(d) ? tmax(highs.get(d)) : null,
            low: lows.has(d) ? tmin(lows.get(d)) : null,
            pop: pops.has(d) ? pops.get(d) : null,
            precipIn: qpf.has(d) ? mmToIn(qpf.get(d)) : null,
        }),
    };
}

// Observations since local midnight at the settlement station (US only): the running max/min and precipitation so far.
function localMidnightUtc(now, tz) {
    const ymd = localDate(now, tz);
    // Find the UTC instant whose local representation is 00:00 on that date by probing the offset at noon UTC.
    const probe = new Date(`${ymd}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(probe);
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const mnt = Number(parts.find((p) => p.type === 'minute').value);
    const offsetMin = (h * 60 + mnt) - 12 * 60; // local - UTC
    return new Date(Date.parse(`${ymd}T00:00:00Z`) - offsetMin * 60e3);
}
function localHour(now, tz) {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' }).formatToParts(now).find((p) => p.type === 'hour').value) % 24;
}

async function fetchObservations(st, now) {
    const start = localMidnightUtc(now, st.tz).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const j = await getJson('nws', `${NWS}/stations/${encodeURIComponent(st.station)}/observations?start=${encodeURIComponent(start)}&limit=200`, { accept: 'application/geo+json' });
    const feats = j?.features || [];
    let high = null;
    let low = null;
    let precipIn = 0;
    let anyPrecip = false;
    let last = null;
    for (const f of feats) {
        const p = f.properties || {};
        const t = p.temperature?.value;
        if (typeof t === 'number') {
            const tf = String(p.temperature.unitCode || '').includes('degC') ? cToF(t) : t;
            high = high === null ? tf : Math.max(high, tf);
            low = low === null ? tf : Math.min(low, tf);
        }
        const pr = p.precipitationLastHour?.value;
        if (typeof pr === 'number') {
            anyPrecip = true;
            precipIn += String(p.precipitationLastHour.unitCode || '').includes('mm') ? pr / 25.4 : pr;
        }
        if (p.timestamp && (!last || p.timestamp > last)) last = p.timestamp;
    }
    return { count: feats.length, high, low, precipIn: anyPrecip ? precipIn : null, last };
}

async function fetchOpenMeteo(st) {
    const url = `${OPEN_METEO}?latitude=${st.lat}&longitude=${st.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=${encodeURIComponent(st.tz)}&forecast_days=${OPEN_METEO_DAYS}`;
    const j = await getJson('open-meteo', url);
    const d = j?.daily;
    if (!d?.time) throw new Error('Open-Meteo response has no daily block');
    const idx = new Map(d.time.map((t, i) => [t, i]));
    return {
        source: 'open-meteo',
        model: 'best_match',
        elevationM: j.elevation ?? null,
        byDate: (date) => {
            const i = idx.get(date);
            if (i === undefined) return { high: null, low: null, pop: null, precipIn: null };
            return { high: d.temperature_2m_max?.[i] ?? null, low: d.temperature_2m_min?.[i] ?? null, pop: d.precipitation_probability_max?.[i] ?? null, precipIn: d.precipitation_sum?.[i] ?? null };
        },
    };
}

// ---------- markets ----------

function parseMarket(m, seriesTicker, seriesInfo) {
    const kind = KINDS[Object.keys(KINDS).find((k) => seriesTicker.startsWith(k))] || null;
    const station = resolveStation(seriesTicker, m.rules_primary);
    const unit = /celsius|°\s?c\b/i.test(m.rules_primary || '') ? 'C' : (/millimet/i.test(m.rules_primary || '') ? 'mm' : (kind === 'rain' ? 'in' : 'F'));
    const floor = typeof m.floor_strike === 'number' ? m.floor_strike : null;
    const cap = typeof m.cap_strike === 'number' ? m.cap_strike : null;
    // Temperature markets settle on whole degrees: "greater than 69" means 70 or above, "less than 62" means 61 or below,
    // "between 68-69" is inclusive. Rain markets are "strictly greater than <amount>".
    let lo = null;
    let hi = null;
    if (kind === 'rain') {
        lo = floor;
    } else if (m.strike_type === 'greater') lo = floor !== null ? (Number.isInteger(floor) ? floor + 1 : floor) : null;
    else if (m.strike_type === 'less') hi = cap !== null ? (Number.isInteger(cap) ? cap - 1 : cap) : null;
    else if (m.strike_type === 'between') { lo = floor; hi = cap; }
    const num = (s) => (s === null || s === undefined || s === '' ? null : Number(s));
    const yesBid = num(m.yes_bid_dollars ?? (m.yes_bid !== undefined ? m.yes_bid / 100 : null));
    const yesAsk = num(m.yes_ask_dollars ?? (m.yes_ask !== undefined ? m.yes_ask / 100 : null));
    const last = num(m.last_price_dollars ?? (m.last_price !== undefined ? m.last_price / 100 : null));
    return {
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        seriesTicker,
        seriesTitle: seriesInfo?.title?.trim() || null,
        kind,
        title: m.title || null,
        bracketLabel: m.yes_sub_title || m.subtitle || null,
        strikeType: m.strike_type || null,
        floorStrike: floor,
        capStrike: cap,
        bracketLow: lo,
        bracketHigh: hi,
        unit,
        targetDate: parseTickerDate(m.ticker),
        station,
        closeTime: m.close_time || null,
        expectedExpirationTime: m.expected_expiration_time || null,
        status: m.status || null,
        yesBid,
        yesAsk,
        lastPrice: last,
        volume: num(m.volume_fp ?? m.volume),
        volume24h: num(m.volume_24h_fp ?? m.volume_24h),
        openInterest: num(m.open_interest_fp ?? m.open_interest),
        settlementSource: (seriesInfo?.settlement_sources || []).map((s) => s.name).join(', ') || null,
        rulesPrimary: m.rules_primary || null,
    };
}

async function fetchSeriesMarkets(seriesTicker, statusFilter) {
    const out = [];
    let cursor = '';
    do {
        const j = await getJson('kalshi', `${KALSHI}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=${statusFilter}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        out.push(...(j?.markets || []));
        cursor = j?.cursor || '';
    } while (cursor && out.length < 2000);
    return out;
}

async function fetchOrderbook(ticker, depth) {
    const j = await getJson('kalshi', `${KALSHI}/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`);
    const ob = j?.orderbook_fp || j?.orderbook || {};
    const yes = (ob.yes_dollars || (ob.yes || []).map(([p, q]) => [p / 100, q])).map(([p, q]) => [Number(p), Number(q)]);
    const no = (ob.no_dollars || (ob.no || []).map(([p, q]) => [p / 100, q])).map(([p, q]) => [Number(p), Number(q)]);
    const bestYesBid = yes.length ? Math.max(...yes.map(([p]) => p)) : null;
    const bestNoBid = no.length ? Math.max(...no.map(([p]) => p)) : null;
    return {
        bookYesBid: bestYesBid,
        bookYesAsk: bestNoBid !== null ? round(1 - bestNoBid, 4) : null,
        bookYesBidSize: bestYesBid !== null ? yes.filter(([p]) => p === bestYesBid).reduce((a, [, q]) => a + q, 0) : null,
        bookYesAskSize: bestNoBid !== null ? no.filter(([p]) => p === bestNoBid).reduce((a, [, q]) => a + q, 0) : null,
        bookYesDepth: yes.reduce((a, [, q]) => a + q, 0),
        bookNoDepth: no.reduce((a, [, q]) => a + q, 0),
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
        seriesTickers = [],
        marketTypes = ['high', 'low', 'rain'],
        cities = [],
        maxDaysAhead = 7,
        maxMarkets = 500,
        includeOrderbook = true,
        orderbookDepth = 5,
        forecastSources = ['nws', 'open-meteo'],
        sigmaScale = 1,
        leadTimeGrowth = 0.25,
        sigmaOverrides = {},
        includeUnscored = true,
        minVolume = 0,
        sameDayCutoffHour = 12,
        includeObservations = true,
    } = input;

    if (!Array.isArray(seriesTickers) || seriesTickers.some((s) => typeof s !== 'string')) throw new InputError('seriesTickers must be an array of strings such as ["KXHIGHNY", "KXLOW*"].');
    if (!Array.isArray(marketTypes) || marketTypes.length === 0 || marketTypes.some((t) => !['high', 'low', 'rain'].includes(t))) throw new InputError('marketTypes must be a non-empty array of "high", "low", "rain".');
    if (!Array.isArray(cities) || cities.some((c) => typeof c !== 'string')) throw new InputError('cities must be an array of strings (city names, CLI codes or ICAO codes).');
    if (!Number.isInteger(maxDaysAhead) || maxDaysAhead < 0 || maxDaysAhead > 14) throw new InputError('maxDaysAhead must be an integer between 0 and 14.');
    if (!Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > MAX_MARKETS_CAP) throw new InputError(`maxMarkets must be an integer between 1 and ${MAX_MARKETS_CAP}.`);
    if (!Number.isInteger(orderbookDepth) || orderbookDepth < 1 || orderbookDepth > 100) throw new InputError('orderbookDepth must be an integer between 1 and 100.');
    if (!Array.isArray(forecastSources) || forecastSources.length === 0 || forecastSources.some((s) => !['nws', 'open-meteo'].includes(s))) throw new InputError('forecastSources must be a non-empty array of "nws", "open-meteo".');
    if (!(Number(sigmaScale) > 0 && Number(sigmaScale) <= 10)) throw new InputError('sigmaScale must be a number between 0 and 10.');
    if (!(Number(leadTimeGrowth) >= 0 && Number(leadTimeGrowth) <= 2)) throw new InputError('leadTimeGrowth must be a number between 0 and 2.');
    if (sigmaOverrides && (typeof sigmaOverrides !== 'object' || Array.isArray(sigmaOverrides) || Object.values(sigmaOverrides).some((v) => !(Number(v) > 0)))) throw new InputError('sigmaOverrides must be an object of positive numbers keyed by station code, e.g. {"CLINYC": 2.5}.');
    if (!(Number(minVolume) >= 0)) throw new InputError('minVolume must be a number >= 0.');
    if (!Number.isInteger(sameDayCutoffHour) || sameDayCutoffHour < 0 || sameDayCutoffHour > 24) throw new InputError('sameDayCutoffHour must be an integer between 0 (never score same-day markets) and 24 (always score them).');

    const charger = await makeCharger();
    const start = await charger.charge('actor-start', 1);
    if (start.limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    const stats = { seriesScanned: 0, marketsFound: 0, marketsFilteredOut: 0, stationsResolved: 0, forecastFetches: 0, forecastFailures: 0, observationFetches: 0, orderbookFetches: 0, marketsScored: 0, marketsUnscored: 0, unscoredReasons: {} };

    // 1. Series discovery.
    const prefixes = Object.keys(KINDS).filter((k) => marketTypes.includes(KINDS[k]));
    const seriesList = await getJson('kalshi', `${KALSHI}/series?category=${encodeURIComponent('Climate and Weather')}`);
    const allSeries = (seriesList?.series || []).filter((s) => prefixes.some((p) => s.ticker.startsWith(p)));
    const byTicker = new Map(allSeries.map((s) => [s.ticker, s]));
    let selected;
    if (seriesTickers.length) {
        selected = [];
        for (const want of seriesTickers.map((s) => s.trim().toUpperCase()).filter(Boolean)) {
            const hits = want.endsWith('*') ? allSeries.filter((s) => s.ticker.startsWith(want.slice(0, -1))) : (byTicker.has(want) ? [byTicker.get(want)] : [{ ticker: want, title: null, frequency: null, settlement_sources: [] }]);
            if (hits.length === 0) log.warning(`No weather series matches ${want}`);
            selected.push(...hits);
        }
    } else {
        selected = allSeries.filter((s) => s.frequency === 'daily');
    }
    selected = [...new Map(selected.map((s) => [s.ticker, s])).values()];
    if (selected.length === 0) throw new InputError(`No series selected. ${allSeries.length} weather series exist for the chosen market types; pass tickers such as ${allSeries.slice(0, 3).map((s) => s.ticker).join(', ')} or leave seriesTickers empty for all daily series.`);
    log.info(`Scanning ${selected.length} series (${seriesTickers.length ? 'from input' : 'all daily temperature/rain series'}) for open markets`);

    // 2. Open markets per series.
    const cityFilter = cities.map((c) => c.trim().toLowerCase()).filter(Boolean);
    const markets = [];
    for (const s of selected) {
        stats.seriesScanned++;
        let raw;
        try {
            raw = await fetchSeriesMarkets(s.ticker, 'open');
        } catch (e) {
            log.warning(`${s.ticker}: ${e.message}`);
            continue;
        }
        for (const m of raw) {
            stats.marketsFound++;
            const pm = parseMarket(m, s.ticker, byTicker.get(s.ticker) || s);
            if (!pm.kind || !marketTypes.includes(pm.kind)) { stats.marketsFilteredOut++; continue; }
            if (cityFilter.length) {
                const hay = [pm.station?.city, pm.station?.code, pm.station?.station, pm.station?.region].filter(Boolean).map((x) => x.toLowerCase());
                if (!cityFilter.some((c) => hay.some((h) => h === c || h.includes(c)))) { stats.marketsFilteredOut++; continue; }
            }
            if (Number(minVolume) > 0 && (pm.volume ?? 0) < Number(minVolume)) { stats.marketsFilteredOut++; continue; }
            markets.push(pm);
        }
        if (markets.length >= maxMarkets) break;
    }
    markets.sort((a, b) => a.seriesTicker.localeCompare(b.seriesTicker) || String(a.targetDate).localeCompare(String(b.targetDate)) || (a.bracketLow ?? -1e9) - (b.bracketLow ?? -1e9));
    const selectedMarkets = markets.slice(0, maxMarkets);
    log.info(`${stats.marketsFound} open markets found, ${selectedMarkets.length} selected (maxMarkets=${maxMarkets})`);

    // 3. Forecasts, once per station.
    const stationCodes = [...new Set(selectedMarkets.map((m) => m.station?.code).filter((c) => c && !selectedMarkets.find((m) => m.station?.code === c)?.station?.unknown))];
    const forecasts = new Map();
    const forecastErrors = [];
    for (const code of stationCodes) {
        const st = STATIONS[code];
        if (!st) continue;
        stats.stationsResolved++;
        const entry = { nws: null, openMeteo: null, errors: [] };
        if (forecastSources.includes('nws') && st.country === 'US') {
            stats.forecastFetches++;
            try {
                entry.nws = await fetchNws(st);
            } catch (e) {
                stats.forecastFailures++;
                entry.errors.push(`nws: ${e.message}`);
                forecastErrors.push({ station: code, source: 'nws', error: e.message });
                log.warning(`NWS forecast for ${code} (${st.city}) failed: ${e.message}`);
            }
        }
        if (forecastSources.includes('open-meteo')) {
            stats.forecastFetches++;
            try {
                entry.openMeteo = await fetchOpenMeteo(st);
            } catch (e) {
                stats.forecastFailures++;
                entry.errors.push(`open-meteo: ${e.message}`);
                forecastErrors.push({ station: code, source: 'open-meteo', error: e.message });
                log.warning(`Open-Meteo forecast for ${code} (${st.city}) failed: ${e.message}`);
            }
        }
        forecasts.set(code, entry);
        log.info(`${code} ${st.city}: nws=${entry.nws ? 'ok' : '-'} open-meteo=${entry.openMeteo ? 'ok' : '-'}`);
    }

    // 3b. Observations so far today for US stations that have a same-day market.
    const now = new Date();
    const observations = new Map();
    if (includeObservations) {
        for (const code of stationCodes) {
            const st = STATIONS[code];
            if (!st || st.country !== 'US') continue;
            const today = localDate(now, st.tz);
            if (!selectedMarkets.some((m) => m.station?.code === code && m.targetDate === today)) continue;
            stats.observationFetches++;
            try {
                observations.set(code, await fetchObservations(st, now));
            } catch (e) {
                forecastErrors.push({ station: code, source: 'nws-observations', error: e.message });
                log.warning(`NWS observations for ${code} failed: ${e.message}`);
            }
        }
    }

    // 4. Score.
    const rows = [];
    const unscored = (reason) => { stats.unscoredReasons[reason] = (stats.unscoredReasons[reason] || 0) + 1; return reason; };
    for (const m of selectedMarkets) {
        const st = m.station && !m.station.unknown ? m.station : null;
        const notes = [];
        const row = {
            ticker: m.ticker,
            eventTicker: m.eventTicker,
            seriesTicker: m.seriesTicker,
            seriesTitle: m.seriesTitle,
            kind: m.kind,
            title: m.title,
            bracketLabel: m.bracketLabel,
            city: st?.city ?? null,
            region: st?.region ?? null,
            country: st?.country ?? null,
            stationCode: m.station?.code ?? null,
            station: st?.station ?? null,
            lat: st?.lat ?? null,
            lon: st?.lon ?? null,
            timezone: st?.tz ?? null,
            targetDate: m.targetDate,
            leadDays: null,
            unit: m.unit,
            strikeType: m.strikeType,
            floorStrike: m.floorStrike,
            capStrike: m.capStrike,
            bracketLow: m.bracketLow,
            bracketHigh: m.bracketHigh,
            closeTime: m.closeTime,
            expectedExpirationTime: m.expectedExpirationTime,
            status: m.status,
            yesBid: m.yesBid,
            yesAsk: m.yesAsk,
            yesMid: m.yesBid !== null && m.yesAsk !== null ? round((m.yesBid + m.yesAsk) / 2) : m.lastPrice,
            spread: m.yesBid !== null && m.yesAsk !== null ? round(m.yesAsk - m.yesBid) : null,
            lastPrice: m.lastPrice,
            volume: m.volume,
            volume24h: m.volume24h,
            openInterest: m.openInterest,
            bookYesBid: null,
            bookYesAsk: null,
            bookYesBidSize: null,
            bookYesAskSize: null,
            bookYesDepth: null,
            bookNoDepth: null,
            nwsHigh: null,
            nwsLow: null,
            nwsPop: null,
            nwsPrecipIn: null,
            nwsOffice: null,
            openMeteoHigh: null,
            openMeteoLow: null,
            openMeteoPop: null,
            openMeteoPrecipIn: null,
            observedHighSoFar: null,
            observedLowSoFar: null,
            observedPrecipSoFarIn: null,
            lastObservationTime: null,
            localHourAtStation: null,
            forecastValue: null,
            forecastSourcesUsed: [],
            sigma: null,
            modelProbability: null,
            edge: null,
            absEdge: null,
            scored: false,
            notes,
            settlementSource: m.settlementSource,
            rulesPrimary: m.rulesPrimary,
            fetchedAt: now.toISOString(),
        };
        if (includeOrderbook) {
            try {
                stats.orderbookFetches++;
                Object.assign(row, await fetchOrderbook(m.ticker, orderbookDepth));
                if (row.bookYesBid !== null && row.bookYesAsk !== null) {
                    row.yesMid = round((row.bookYesBid + row.bookYesAsk) / 2);
                    row.spread = round(row.bookYesAsk - row.bookYesBid);
                }
            } catch (e) {
                notes.push(`orderbook: ${e.message}`);
            }
        }
        let reason = null;
        if (!st) reason = unscored(m.station?.code ? `station ${m.station.code} not in the station table` : 'no settlement station found in the market rules');
        else if (!m.targetDate) reason = unscored('target date not found in ticker');
        else {
            const today = localDate(now, st.tz);
            row.leadDays = daysBetween(today, m.targetDate);
            const f = forecasts.get(st.code) || { nws: null, openMeteo: null };
            const n = f.nws ? f.nws.byDate(m.targetDate) : null;
            const o = f.openMeteo ? f.openMeteo.byDate(m.targetDate) : null;
            if (n) { row.nwsHigh = round(n.high, 1); row.nwsLow = round(n.low, 1); row.nwsPop = round(n.pop, 0); row.nwsPrecipIn = round(n.precipIn, 2); row.nwsOffice = f.nws.office; }
            if (o) { row.openMeteoHigh = round(o.high, 1); row.openMeteoLow = round(o.low, 1); row.openMeteoPop = round(o.pop, 0); row.openMeteoPrecipIn = round(o.precipIn, 2); }
            const hourNow = localHour(now, st.tz);
            row.localHourAtStation = hourNow;
            if (row.leadDays === 0 && observations.has(st.code)) {
                const ob = observations.get(st.code);
                row.observedHighSoFar = round(ob.high, 1);
                row.observedLowSoFar = round(ob.low, 1);
                row.observedPrecipSoFarIn = round(ob.precipIn, 2);
                row.lastObservationTime = ob.last;
            }
            if (row.leadDays < 0) reason = unscored('target date already passed (awaiting settlement)');
            else if (row.leadDays > maxDaysAhead) reason = unscored(`target date beyond maxDaysAhead (${maxDaysAhead})`);
            else if (row.leadDays === 0 && hourNow >= sameDayCutoffHour) reason = unscored(`same-day market after ${sameDayCutoffHour}:00 local; the outcome is largely observed, see observed* fields`);
            else if (m.kind === 'rain') {
                if (m.bracketLow !== 0 || m.strikeType !== 'greater') reason = unscored('rain amount threshold above zero is not modelled');
                else {
                    const pops = [n?.pop, o?.pop].map((p) => (typeof p === 'number' ? p / 100 : null));
                    row.forecastSourcesUsed = ['nws', 'open-meteo'].filter((_, i) => pops[i] !== null);
                    const p = mean(pops);
                    if (p === null) reason = unscored('no precipitation probability available for the target date');
                    else {
                        row.forecastValue = round(p * 100, 0);
                        row.modelProbability = round(Math.min(0.99, Math.max(0.01, p)));
                    }
                }
            } else {
                const vals = m.kind === 'high' ? [n?.high, o?.high] : [n?.low, o?.low];
                row.forecastSourcesUsed = ['nws', 'open-meteo'].filter((_, i) => typeof vals[i] === 'number');
                const muF = mean(vals);
                if (muF === null) reason = unscored('no temperature forecast available for the target date');
                else if (m.bracketLow === null && m.bracketHigh === null) reason = unscored('bracket bounds missing');
                else {
                    const sigmaBaseF = Number(sigmaOverrides?.[st.code] ?? sigmaOverrides?.[st.station] ?? st.sigmaF);
                    let sigmaF = sigmaBaseF * Number(sigmaScale) * (1 + Number(leadTimeGrowth) * Math.max(0, row.leadDays - 1));
                    if (row.leadDays === 0) { sigmaF *= 0.8; notes.push('target date is today at the station; part of the day is already observed'); }
                    const inC = m.unit === 'C';
                    const mu = inC ? fToC(muF) : muF;
                    const sigma = inC ? sigmaF * 5 / 9 : sigmaF;
                    // Settlement is a whole degree, so a bracket [lo, hi] covers the continuous interval (lo-0.5, hi+0.5).
                    const half = Number.isInteger(m.bracketLow ?? m.bracketHigh) ? 0.5 : 0;
                    const upper = m.bracketHigh === null ? Infinity : m.bracketHigh + half;
                    const lower = m.bracketLow === null ? -Infinity : m.bracketLow - half;
                    const p = normCdf((upper - mu) / sigma) - normCdf((lower - mu) / sigma);
                    row.forecastValue = round(mu, 1);
                    row.sigma = round(sigma, 2);
                    row.modelProbability = round(Math.min(0.999, Math.max(0.001, p)));
                    if (row.forecastSourcesUsed.length === 2 && Math.abs(vals[0] - vals[1]) >= 4) notes.push(`sources disagree by ${Math.abs(vals[0] - vals[1]).toFixed(1)} F`);
                }
            }
        }
        if (reason) {
            notes.unshift(reason);
            stats.marketsUnscored++;
        } else {
            row.scored = true;
            row.edge = row.yesMid !== null ? round(row.modelProbability - row.yesMid) : null;
            row.absEdge = row.edge !== null ? Math.abs(row.edge) : null;
            stats.marketsScored++;
        }
        rows.push(row);
    }

    // 5. Charge for scored markets, push.
    const scoredRows = rows.filter((r) => r.scored);
    const charged = await charger.charge('market-scored', scoredRows.length);
    let allowed = charged.allowed;
    const out = [];
    for (const r of rows) {
        if (r.scored) {
            if (allowed <= 0) continue;
            allowed--;
            out.push(r);
        } else if (includeUnscored) out.push(r);
    }
    if (out.length) await Actor.pushData(out);
    const stopReason = charged.limitReached || charged.allowed < scoredRows.length ? 'maximum charge reached (market-scored)' : (markets.length > maxMarkets ? `maxMarkets (${maxMarkets}) reached` : 'completed');

    const topEdges = scoredRows.slice().sort((a, b) => b.absEdge - a.absEdge).slice(0, 10).map((r) => ({ ticker: r.ticker, city: r.city, bracketLabel: r.bracketLabel, targetDate: r.targetDate, yesMid: r.yesMid, modelProbability: r.modelProbability, edge: r.edge, forecastValue: r.forecastValue, sigma: r.sigma }));
    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason,
        disclaimer: 'Descriptive data only. The model probability is a normal distribution around a public forecast with an assumed standard deviation; it is not a prediction service and nothing here is trading advice.',
        assumptions: { sigmaScale: Number(sigmaScale), leadTimeGrowth: Number(leadTimeGrowth), sigmaOverrides: sigmaOverrides || {}, forecastSources, blend: 'arithmetic mean of available sources', sameDayCutoffHour, sameDaySigmaFactor: 0.8 },
        stats,
        stations: stationCodes.map((code) => ({ code, ...STATIONS[code], nws: Boolean(forecasts.get(code)?.nws), openMeteo: Boolean(forecasts.get(code)?.openMeteo), errors: forecasts.get(code)?.errors || [] })),
        forecastErrors,
        largestAbsoluteEdges: topEdges,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${out.length} rows (${stats.marketsScored} scored, ${stats.marketsUnscored} unscored) from ${stats.seriesScanned} series and ${stats.stationsResolved} stations; stop reason: ${stopReason}`);
    await Actor.setStatusMessage(`${stats.marketsScored} markets scored, ${stats.marketsUnscored} unscored (${stopReason})`);
    if (stats.marketsFound === 0) log.warning('No open markets were found for the selected series. Kalshi lists weather markets one to two days ahead; try again later or widen the selection.');
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
