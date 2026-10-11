import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const MIN_GAP_MS = 500; // two requests per second across all ESPN hosts
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESULTS_CAP = 20000;
const MAX_SPAN_DAYS = 366;
const DAY_BY_DAY_LIMIT = 45; // longer spans are fetched month by month and filtered
const MODES = ['scoreboard', 'schedule', 'standings', 'game', 'teams', 'roster', 'injuries', 'news', 'odds', 'rankings'];
const STATES = ['pre', 'in', 'post'];
const ATHLETE_SPORTS = new Set(['tennis', 'golf', 'racing', 'mma']);
const COLLEGE_GROUP_DEFAULT = { 'college-football': '80', 'mens-college-basketball': '50', 'womens-college-basketball': '50' };
const EVENT_NAME = { scoreboard: 'event-row', schedule: 'event-row', teams: 'event-row', roster: 'event-row', injuries: 'event-row', game: 'game-summary', standings: 'standings-row', rankings: 'standings-row', news: 'news-row', odds: 'odds-row' };

// Short codes buyers type; anything else is passed through as sport/league exactly as ESPN names it.
const ALIASES = {
    nfl: 'football/nfl', nba: 'basketball/nba', wnba: 'basketball/wnba', mlb: 'baseball/mlb', nhl: 'hockey/nhl',
    ncaaf: 'football/college-football', cfb: 'football/college-football', 'college-football': 'football/college-football',
    ncaam: 'basketball/mens-college-basketball', ncaab: 'basketball/mens-college-basketball', cbb: 'basketball/mens-college-basketball', 'mens-college-basketball': 'basketball/mens-college-basketball',
    ncaaw: 'basketball/womens-college-basketball', wcbb: 'basketball/womens-college-basketball', 'womens-college-basketball': 'basketball/womens-college-basketball',
    epl: 'soccer/eng.1', 'premier-league': 'soccer/eng.1', championship: 'soccer/eng.2', 'fa-cup': 'soccer/eng.fa', 'efl-cup': 'soccer/eng.league_cup',
    laliga: 'soccer/esp.1', 'la-liga': 'soccer/esp.1', bundesliga: 'soccer/ger.1', seriea: 'soccer/ita.1', 'serie-a': 'soccer/ita.1', ligue1: 'soccer/fra.1', 'ligue-1': 'soccer/fra.1',
    eredivisie: 'soccer/ned.1', 'primeira-liga': 'soccer/por.1', 'liga-mx': 'soccer/mex.1', mls: 'soccer/usa.1', nwsl: 'soccer/usa.nwsl', 'brasileirao': 'soccer/bra.1', 'saudi-pro-league': 'soccer/ksa.1', 'a-league': 'soccer/aus.1',
    ucl: 'soccer/uefa.champions', 'champions-league': 'soccer/uefa.champions', uel: 'soccer/uefa.europa', 'europa-league': 'soccer/uefa.europa', uecl: 'soccer/uefa.europa.conf',
    'world-cup': 'soccer/fifa.world', 'womens-world-cup': 'soccer/fifa.wwc', euros: 'soccer/uefa.euro', 'copa-america': 'soccer/conmebol.america', libertadores: 'soccer/conmebol.libertadores', 'nations-league': 'soccer/uefa.nations',
    'soccer-all': 'soccer/all', soccer: 'soccer/all',
    atp: 'tennis/atp', wta: 'tennis/wta', pga: 'golf/pga', lpga: 'golf/lpga', 'dp-world': 'golf/eur', liv: 'golf/liv',
    ufc: 'mma/ufc', pfl: 'mma/pfl', bellator: 'mma/bellator', f1: 'racing/f1', nascar: 'racing/nascar-premier', indycar: 'racing/irl', ipl: 'cricket/8048',
};

class InputError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (url) => url.replace(/^https?:\/\//, '').slice(0, 140);

// ---------- http: one global pace, retries on 429/5xx, null on 400/404 ----------

const http = { requests: 0, retries: 0 };
let lastRequestAt = 0;
async function pace() {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
}

async function getJson(url, { attempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await pace();
        http.requests++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                const retryAfter = Number(res.headers.get('retry-after'));
                const delay = retryAfter > 0 && retryAfter <= 120 ? retryAfter * 1000 : (res.status === 429 ? 5000 : 1500) * attempt;
                if (attempt < attempts) {
                    http.retries++;
                    log.warning(`${res.status} on ${short(url)} (attempt ${attempt}/${attempts}); retrying in ${delay} ms`);
                    await sleep(delay);
                }
                continue;
            }
            // ESPN answers 404 for unknown leagues, teams and events and 400 for unsupported queries; both mean "nothing here".
            if (res.status === 404 || res.status === 400) {
                log.debug(`${res.status} ${short(url)}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
                return null;
            }
            if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${short(url)}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`Non-JSON response from ${short(url)}`);
            }
        } catch (e) {
            if (/^(HTTP \d+ from|Non-JSON)/.test(e.message)) throw e;
            lastError = e.name === 'AbortError' ? new Error(`timeout after ${REQUEST_TIMEOUT_MS} ms`) : e;
            if (attempt < attempts) {
                http.retries++;
                await sleep(1500 * attempt);
            }
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${short(url)} failed after ${attempts} attempts (${lastError?.message})`);
}

// ---------- small helpers ----------

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim().toUpperCase();
    if (s === 'EVEN' || s === 'EV') return 100;
    if (s === 'PK' || s === 'PICK') return 0;
    const n = Number(s.replace(/^[OU](?=[-+]?\d)/, '').replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
}
const negate = (n) => (n === null ? null : (n === 0 ? 0 : -n));
const uniq = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined && x !== ''))];
const pick = (arr, pred) => (Array.isArray(arr) ? arr.find(pred) : undefined);

const fmtCache = new Map();
function fmt(tz, opts) {
    const key = `${tz}|${JSON.stringify(opts)}`;
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts }));
    return fmtCache.get(key);
}
const ymdOf = (date, tz) => fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
function localDateTime(iso, tz) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = Object.fromEntries(fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
const isoUtc = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? str(s) : d.toISOString();
};
const utcDay = (ymd) => Date.UTC(...ymd.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
const shiftYmd = (ymd, days) => new Date(utcDay(ymd) + days * 86400e3).toISOString().slice(0, 10);
const validYmd = (ymd) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
    const d = new Date(`${ymd}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(ymd);
};
const leagueIdOf = (uid) => /~l:(\d+)/.exec(uid || '')?.[1] ?? null;

function parseDates(input, tz) {
    const s = String(input ?? 'today').trim().toLowerCase();
    const today = ymdOf(new Date(), tz);
    const single = (ymd) => ({ kind: 'days', days: [ymd], from: ymd, to: ymd });
    const norm = (t) => {
        const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    };
    if (s === '' || s === 'today') return single(today);
    if (s === 'yesterday') return single(shiftYmd(today, -1));
    if (s === 'tomorrow') return single(shiftYmd(today, 1));
    if (/^\d{4}$/.test(s)) return { kind: 'year', tokens: [s], from: `${s}-01-01`, to: `${s}-12-31` };
    if (/^\d{6}$/.test(s)) return { kind: 'month', tokens: [s], from: `${s.slice(0, 4)}-${s.slice(4)}-01`, to: `${s.slice(0, 4)}-${s.slice(4)}-31` };
    const one = norm(s);
    if (one) {
        if (!validYmd(one)) throw new InputError(`dates: "${input}" is not a calendar date.`);
        return single(one);
    }
    const m = /^(\d{4}-?\d{2}-?\d{2})\s*(?:\.\.|-|to|\/)\s*(\d{4}-?\d{2}-?\d{2})$/.exec(s);
    if (m) {
        const from = norm(m[1]);
        const to = norm(m[2]);
        if (!from || !to || !validYmd(from) || !validYmd(to)) throw new InputError(`dates: "${input}" is not a valid span.`);
        if (to < from) throw new InputError(`dates: the span "${input}" ends before it starts.`);
        const n = Math.round((utcDay(to) - utcDay(from)) / 86400e3) + 1;
        if (n > MAX_SPAN_DAYS) throw new InputError(`dates: the span "${input}" covers ${n} days; the maximum is ${MAX_SPAN_DAYS}.`);
        const days = [];
        for (let i = 0; i < n; i++) days.push(shiftYmd(from, i));
        return { kind: 'days', days, from, to };
    }
    throw new InputError(`dates: "${input}" is not understood. Use today, yesterday, tomorrow, 2026-10-11, 20261011, 2026-10-01..2026-10-07, 202610 or 2026.`);
}

// Request tokens for the scoreboard: one per day for short spans, one per month for long spans (rows are filtered to the span afterwards).
function dateTokens(parsed) {
    if (parsed.kind !== 'days') return parsed.tokens;
    if (parsed.days.length <= DAY_BY_DAY_LIMIT) return parsed.days.map((d) => d.replace(/-/g, ''));
    const months = [];
    for (const d of parsed.days) {
        const m = d.slice(0, 7).replace('-', '');
        if (months[months.length - 1] !== m) months.push(m);
    }
    return months;
}

function resolveLeague(code) {
    const raw = String(code ?? '').trim();
    const s = raw.toLowerCase();
    if (!s) return null;
    let path = ALIASES[s] || null;
    if (!path) {
        if (s.includes('/')) path = s;
        else if (/^\d+$/.test(s)) path = `cricket/${s}`;
        else if (s.includes('.')) path = `soccer/${s}`;
    }
    if (!path || !/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(path)) {
        throw new InputError(`"${raw}" is not a league code. Use a short code (${Object.keys(ALIASES).slice(0, 12).join(', ')} ...) or sport/league as ESPN names it (soccer/ned.1, golf/eur, racing/nascar-premier, cricket/8048).`);
    }
    const [sport, league] = path.split('/');
    return { code: raw, sport, league, key: `${sport}/${league}`, athlete: ATHLETE_SPORTS.has(sport), collegeGroup: COLLEGE_GROUP_DEFAULT[league] || null };
}

// ---------- normalizers ----------

function teamOf(t) {
    if (!t) return null;
    return {
        id: str(t.id),
        abbreviation: t.abbreviation ?? null,
        displayName: t.displayName ?? (t.location && t.name ? `${t.location} ${t.name}` : (t.name ?? t.location ?? null)),
        shortDisplayName: t.shortDisplayName ?? null,
        location: t.location ?? null,
        name: t.name ?? null,
        logo: t.logo ?? t.logos?.[0]?.href ?? null,
        color: t.color ?? null,
    };
}

function statusOf(s) {
    const t = s?.type || {};
    return {
        state: t.state ?? null,
        name: t.name ?? null,
        description: t.description ?? null,
        detail: t.detail ?? null,
        shortDetail: t.shortDetail ?? null,
        completed: typeof t.completed === 'boolean' ? t.completed : (t.state === 'post' ? true : null),
        period: num(s?.period),
        clock: s?.displayClock ?? null,
        clockSeconds: num(s?.clock),
        summary: s?.summary ?? null,
    };
}

function venueOf(v) {
    if (!v) return null;
    return {
        id: str(v.id),
        name: v.fullName ?? v.displayName ?? v.name ?? null,
        city: v.address?.city ?? null,
        state: v.address?.state ?? null,
        country: v.address?.country ?? null,
        indoor: typeof v.indoor === 'boolean' ? v.indoor : null,
        capacity: num(v.capacity),
    };
}

function broadcastsOf(comp) {
    const names = [];
    for (const b of comp?.broadcasts || []) {
        if (Array.isArray(b.names)) names.push(...b.names);
        else if (b.media?.shortName) names.push(b.media.shortName);
        else if (b.name) names.push(b.name);
    }
    if (!names.length) for (const g of comp?.geoBroadcasts || []) if (g.media?.shortName) names.push(g.media.shortName);
    if (!names.length && comp?.broadcast) names.push(comp.broadcast);
    return uniq(names);
}

function scoreOf(score) {
    if (score === null || score === undefined) return { score: null, scoreText: null };
    if (typeof score === 'object') return { score: num(score.value ?? score.displayValue), scoreText: str(score.displayValue ?? score.value) };
    return { score: num(score), scoreText: str(score) };
}

function recordsOf(c) {
    const recs = Array.isArray(c?.records) ? c.records : (Array.isArray(c?.record) ? c.record : []);
    const find = (...types) => recs.find((r) => types.includes(String(r.type || r.name || '').toLowerCase()))?.summary ?? recs.find((r) => types.includes(String(r.type || r.name || '').toLowerCase()))?.displayValue ?? null;
    return { record: find('total', 'overall', 'ytd') ?? recs[0]?.summary ?? recs[0]?.displayValue ?? null, homeRecord: find('home'), awayRecord: find('road', 'away') };
}

const linescoresOf = (ls) => (Array.isArray(ls) ? ls.map((l) => num(l.value ?? l.displayValue)) : null);

function leadersOf(groups, team) {
    const out = [];
    for (const g of groups || []) {
        const l = g.leaders?.[0];
        if (!l) continue;
        out.push({
            category: g.name ?? null,
            displayName: g.displayName ?? g.shortDisplayName ?? null,
            teamId: team?.id ?? str(l.team?.id) ?? null,
            teamAbbr: team?.abbreviation ?? null,
            athleteId: str(l.athlete?.id),
            athlete: l.athlete?.displayName ?? l.athlete?.fullName ?? null,
            position: l.athlete?.position?.abbreviation ?? null,
            value: num(l.value),
            displayValue: l.displayValue ?? null,
            summary: l.summary ?? null,
        });
    }
    return out;
}

// Tennis doubles pairs arrive as a "team" with a roster of two athletes and no team object.
const pairOf = (c) => (c?.roster?.athletes ? { name: c.roster.displayName ?? c.roster.athletes.map((x) => x.displayName).join(' / '), shortName: c.roster.shortDisplayName ?? null, athletes: c.roster.athletes.map((x) => ({ name: x.displayName ?? x.fullName ?? null, country: x.flag?.alt ?? null })) } : null);

function athleteCompetitorOf(c) {
    const a = c.athlete || {};
    const pair = pairOf(c);
    const sc = scoreOf(c.score);
    return {
        athleteId: str(a.id ?? c.id),
        name: a.displayName ?? a.fullName ?? pair?.name ?? null,
        shortName: a.shortName ?? pair?.shortName ?? null,
        country: a.flag?.alt ?? a.country ?? (pair ? uniq(pair.athletes.map((x) => x.country)).join(' / ') || null : null),
        athletes: pair?.athletes ?? null,
        order: num(c.order),
        homeAway: c.homeAway ?? null,
        winner: typeof c.winner === 'boolean' ? c.winner : (c.winner === 'true' ? true : null),
        score: sc.score,
        scoreText: sc.scoreText,
        linescores: linescoresOf(c.linescores),
        record: c.displayRecord ?? c.records?.[0]?.summary ?? null,
        position: c.status?.position?.displayName ?? null,
        statusDetail: c.status?.displayValue ?? c.status?.detail ?? null,
        headshot: a.headshot?.href ?? null,
    };
}

// One sportsbook line in a stable shape, from any of ESPN's three odds shapes (scoreboard, summary pickcenter, core odds feed).
function oddsOf(o) {
    if (!o) return null;
    const provider = o.provider || {};
    const ht = o.homeTeamOdds || {};
    const at = o.awayTeamOdds || {};
    const favorite = ht.favorite ? 'home' : (at.favorite ? 'away' : null);
    const homeSpread = num(o.spread) ?? num(o.pointSpread?.home?.close?.line) ?? num(ht.current?.pointSpread?.american) ?? num(ht.close?.pointSpread?.american);
    const overUnder = num(o.overUnder) ?? num(o.total?.over?.close?.line) ?? num(o.current?.total?.american) ?? num(o.close?.total?.american);
    const row = {
        provider: provider.displayName ?? provider.name ?? null,
        providerId: str(provider.id),
        details: o.details ?? null,
        favorite,
        favoriteTeamId: favorite === 'home' ? str(ht.team?.id ?? ht.teamId) : (favorite === 'away' ? str(at.team?.id ?? at.teamId) : null),
        homeSpread,
        awaySpread: negate(homeSpread),
        homeSpreadOdds: num(ht.spreadOdds) ?? num(o.pointSpread?.home?.close?.odds) ?? num(ht.current?.spread?.american) ?? num(ht.close?.spread?.american),
        awaySpreadOdds: num(at.spreadOdds) ?? num(o.pointSpread?.away?.close?.odds) ?? num(at.current?.spread?.american) ?? num(at.close?.spread?.american),
        overUnder,
        overOdds: num(o.overOdds) ?? num(o.total?.over?.close?.odds) ?? num(o.current?.over?.american) ?? num(o.close?.over?.american),
        underOdds: num(o.underOdds) ?? num(o.total?.under?.close?.odds) ?? num(o.current?.under?.american) ?? num(o.close?.under?.american),
        homeMoneyline: num(ht.moneyLine) ?? num(o.moneyline?.home?.close?.odds) ?? num(ht.current?.moneyLine?.american) ?? num(ht.close?.moneyLine?.american),
        awayMoneyline: num(at.moneyLine) ?? num(o.moneyline?.away?.close?.odds) ?? num(at.current?.moneyLine?.american) ?? num(at.close?.moneyLine?.american),
        drawMoneyline: num(o.drawOdds?.moneyLine) ?? num(o.current?.draw?.american) ?? num(o.close?.draw?.american),
        open: {
            homeSpread: num(o.pointSpread?.home?.open?.line) ?? num(ht.open?.pointSpread?.american),
            overUnder: num(o.total?.over?.open?.line) ?? num(o.open?.total?.american),
            homeMoneyline: num(o.moneyline?.home?.open?.odds) ?? num(ht.open?.moneyLine?.american),
            awayMoneyline: num(o.moneyline?.away?.open?.odds) ?? num(at.open?.moneyLine?.american),
            overOdds: num(o.total?.over?.open?.odds) ?? num(o.open?.over?.american),
            underOdds: num(o.total?.under?.open?.odds) ?? num(o.open?.under?.american),
            drawMoneyline: num(o.open?.draw?.american),
        },
        moneylineWinner: typeof o.moneylineWinner === 'boolean' ? o.moneylineWinner : null,
        spreadWinner: typeof o.spreadWinner === 'boolean' ? o.spreadWinner : null,
        link: o.link?.href ?? pick(o.links, (l) => (l.rel || []).includes('game'))?.href ?? null,
    };
    if (row.open.homeSpread === null && row.open.overUnder === null && row.open.homeMoneyline === null && row.open.awayMoneyline === null) row.open = null;
    return row;
}

function situationOf(s) {
    if (!s) return null;
    return {
        possessionTeamId: str(s.possession),
        downDistanceText: s.downDistanceText ?? s.shortDownDistanceText ?? null,
        possessionText: s.possessionText ?? null,
        lastPlay: s.lastPlay?.text ?? null,
        balls: num(s.balls),
        strikes: num(s.strikes),
        outs: num(s.outs),
        onFirst: typeof s.onFirst === 'boolean' ? s.onFirst : null,
        onSecond: typeof s.onSecond === 'boolean' ? s.onSecond : null,
        onThird: typeof s.onThird === 'boolean' ? s.onThird : null,
        isRedZone: typeof s.isRedZone === 'boolean' ? s.isRedZone : null,
    };
}

const gamecastUrl = (links) => pick(links, (l) => (l.rel || []).includes('summary') || (l.rel || []).includes('event') || (l.rel || []).includes('desktop'))?.href ?? links?.[0]?.href ?? null;

// A scoreboard or schedule competition (game, match, fight, session, tournament) as one row with stable keys.
function competitionRow(ctx, event, comp, extra = {}) {
    const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
    const isTeam = competitors.some((c) => c.team);
    const twoSided = competitors.length === 2;
    let home = null;
    let away = null;
    if (isTeam || twoSided) {
        const sorted = competitors.slice().sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0));
        home = competitors.find((c) => c.homeAway === 'home') ?? sorted[0] ?? null;
        away = competitors.find((c) => c.homeAway === 'away') ?? sorted.find((c) => c !== home) ?? null;
    }
    const side = (c) => {
        if (!c) return { id: null, team: null, abbr: null, score: null, scoreText: null, winner: null, record: null, homeRecord: null, awayRecord: null, linescores: null, logo: null };
        const sc = scoreOf(c.score);
        const t = c.team ? teamOf(c.team) : null;
        const a = c.athlete || null;
        const pair = pairOf(c);
        const rec = recordsOf(c);
        return {
            id: t?.id ?? str(a?.id ?? c.id),
            team: t?.displayName ?? a?.displayName ?? a?.fullName ?? pair?.name ?? null,
            abbr: t?.abbreviation ?? a?.shortName ?? pair?.shortName ?? null,
            score: sc.score,
            scoreText: sc.scoreText,
            winner: typeof c.winner === 'boolean' ? c.winner : (c.winner === 'true' ? true : null),
            record: rec.record ?? c.displayRecord ?? null,
            homeRecord: rec.homeRecord,
            awayRecord: rec.awayRecord,
            linescores: linescoresOf(c.linescores),
            logo: t?.logo ?? a?.headshot?.href ?? null,
            curatedRank: num(c.curatedRank?.current) === 99 ? null : num(c.curatedRank?.current),
        };
    };
    const h = side(home);
    const a = side(away);
    const status = statusOf(comp.status ?? event.status);
    if (status.state === 'pre') {
        // ESPN reports "0" for games not yet played; keep scores empty until there is one.
        h.score = null; h.scoreText = null; a.score = null; a.scoreText = null;
    }
    const leaders = [];
    for (const c of competitors) if (c.leaders) leaders.push(...leadersOf(c.leaders, c.team ? teamOf(c.team) : null));
    if (!leaders.length && Array.isArray(comp.leaders)) leaders.push(...leadersOf(comp.leaders, null));
    const probables = [];
    for (const c of competitors) for (const p of c.probables || []) probables.push({ teamId: str(c.team?.id), role: p.displayName ?? p.name ?? null, athleteId: str(p.athlete?.id ?? p.playerId), athlete: p.athlete?.displayName ?? null, record: p.record || null });
    const note = comp.notes?.find((n) => n.text)?.text ?? comp.headlines?.[0]?.description ?? event.notes?.find?.((n) => n.text)?.text ?? null;
    const date = isoUtc(comp.date ?? comp.startDate ?? event.date);
    return {
        recordType: 'event',
        sport: ctx.sport,
        league: ctx.league,
        leagueName: ctx.leagueName ?? null,
        eventId: str(event.id),
        competitionId: str(comp.id ?? event.id),
        uid: comp.uid ?? event.uid ?? null,
        leagueId: leagueIdOf(comp.uid ?? event.uid),
        name: event.name ?? null,
        shortName: event.shortName ?? null,
        date,
        dateLocal: localDateTime(date, ctx.timezone),
        timezone: ctx.timezone,
        endDate: isoUtc(comp.endDate ?? event.endDate) ?? null,
        seasonYear: num(event.season?.year),
        seasonType: num(event.season?.type ?? event.seasonType?.type),
        seasonSlug: event.season?.slug ?? event.seasonType?.name ?? null,
        week: num(event.week?.number ?? ctx.week),
        status: status.state,
        statusName: status.name,
        statusDetail: status.detail ?? status.description,
        completed: status.completed,
        period: status.period,
        clock: status.clock,
        competitionType: comp.type?.abbreviation ?? comp.type?.text ?? null,
        round: comp.round?.displayName ?? null,
        grouping: extra.grouping ?? null,
        description: comp.description ?? event.description ?? null,
        homeTeamId: h.id,
        homeTeam: h.team,
        homeAbbr: h.abbr,
        homeScore: h.score,
        homeScoreText: h.scoreText,
        homeWinner: h.winner,
        homeRecord: h.record,
        homeLinescores: h.linescores,
        homeLogo: h.logo,
        homeRank: h.curatedRank,
        awayTeamId: a.id,
        awayTeam: a.team,
        awayAbbr: a.abbr,
        awayScore: a.score,
        awayScoreText: a.scoreText,
        awayWinner: a.winner,
        awayRecord: a.record,
        awayLinescores: a.linescores,
        awayLogo: a.logo,
        awayRank: a.curatedRank,
        winnerId: h.winner ? h.id : (a.winner ? a.id : null),
        competitorCount: competitors.length,
        competitors: isTeam ? null : competitors.map(athleteCompetitorOf),
        neutralSite: typeof comp.neutralSite === 'boolean' ? comp.neutralSite : null,
        attendance: num(comp.attendance),
        venue: venueOf(comp.venue ?? event.venue ?? event.venues?.[0] ?? event.circuit),
        venueName: (comp.venue ?? event.venue ?? event.venues?.[0] ?? event.circuit)?.fullName ?? (comp.venue ?? event.venue)?.displayName ?? null,
        court: comp.venue?.court ?? null,
        broadcasts: broadcastsOf(comp),
        odds: oddsOf(comp.odds?.[0]),
        leaders,
        probables,
        situation: situationOf(comp.situation),
        note,
        headline: comp.headlines?.[0]?.shortLinkText ?? null,
        playByPlayAvailable: typeof comp.playByPlayAvailable === 'boolean' ? comp.playByPlayAvailable : null,
        url: gamecastUrl(event.links) ?? gamecastUrl(comp.links),
        fetchedAt: ctx.fetchedAt,
        ...extra,
    };
}

// Scoreboard event -> rows: team sports and fights have competitions, tennis tournaments have groupings of competitions.
function eventRows(ctx, event) {
    const rows = [];
    if (Array.isArray(event.groupings) && event.groupings.length) {
        for (const g of event.groupings) {
            for (const comp of g.competitions || []) rows.push(competitionRow(ctx, event, comp, { grouping: g.grouping?.displayName ?? null, tournament: event.name ?? null, tournamentId: str(event.id) }));
        }
        return rows;
    }
    for (const comp of event.competitions || [{ id: event.id, status: event.status, competitors: [] }]) rows.push(competitionRow(ctx, event, comp));
    return rows;
}

// ---------- standings, rankings, teams, rosters, injuries, news ----------

const statMap = (stats) => {
    const display = {};
    const values = {};
    for (const s of stats || []) {
        const k = s.name || s.abbreviation;
        if (!k) continue;
        display[k] = s.displayValue ?? (s.value ?? null);
        if (typeof s.value === 'number') values[k] = s.value;
    }
    return { display, values };
};
const statAt = (display, ...names) => {
    for (const n of names) if (display[n] !== undefined) return display[n];
    const lower = Object.fromEntries(Object.keys(display).map((k) => [k.toLowerCase(), k]));
    for (const n of names) if (lower[n.toLowerCase()]) return display[lower[n.toLowerCase()]];
    return null;
};

function standingsRows(ctx, root) {
    const rows = [];
    const walk = (node, ancestors) => {
        const entries = node.standings?.entries || [];
        if (entries.length) {
            const conference = ancestors.length >= 2 ? ancestors[1].name ?? null : null;
            entries.forEach((e, i) => {
                const { display, values } = statMap(e.stats);
                const team = e.team ? teamOf(e.team) : null;
                const athlete = e.athlete || null;
                rows.push({
                    recordType: 'standing',
                    sport: ctx.sport,
                    league: ctx.league,
                    leagueName: ancestors[0]?.name ?? root.name ?? ctx.leagueName ?? null,
                    seasonYear: num(node.standings.season ?? root.season),
                    seasonType: num(node.standings.seasonType),
                    seasonDisplayName: node.standings.seasonDisplayName ?? null,
                    standingsName: node.standings.displayName ?? node.standings.name ?? null,
                    conference,
                    group: node.name ?? null,
                    groupId: str(node.id),
                    groupAbbreviation: node.abbreviation ?? null,
                    rank: num(statAt(display, 'rank')) ?? i + 1,
                    teamId: team?.id ?? null,
                    team: team?.displayName ?? null,
                    teamAbbr: team?.abbreviation ?? null,
                    teamLogo: team?.logo ?? null,
                    athleteId: str(athlete?.id),
                    athlete: athlete?.displayName ?? null,
                    athleteCountry: athlete?.flag?.alt ?? null,
                    note: e.note?.description ?? null,
                    noteRank: num(e.note?.rank),
                    wins: num(statAt(display, 'wins')),
                    losses: num(statAt(display, 'losses')),
                    ties: num(statAt(display, 'ties')),
                    otLosses: num(statAt(display, 'otLosses', 'OTL', 'otlosses')),
                    winPercent: num(statAt(display, 'winPercent')),
                    points: num(statAt(display, 'points', 'championshipPts')),
                    gamesPlayed: num(statAt(display, 'gamesPlayed')),
                    gamesBehind: num(statAt(display, 'gamesBehind')),
                    pointsFor: num(statAt(display, 'pointsFor')),
                    pointsAgainst: num(statAt(display, 'pointsAgainst')),
                    pointDifferential: num(statAt(display, 'pointDifferential', 'differential')),
                    streak: statAt(display, 'streak'),
                    playoffSeed: num(statAt(display, 'playoffSeed')),
                    clincher: statAt(display, 'clincher'),
                    overallRecord: statAt(display, 'overall'),
                    homeRecord: statAt(display, 'Home', 'home'),
                    awayRecord: statAt(display, 'Road', 'Away', 'road', 'away'),
                    divisionRecord: statAt(display, 'vs. Div.', 'divisionRecord'),
                    conferenceRecord: statAt(display, 'vs. Conf.', 'conferenceRecord'),
                    lastTenRecord: statAt(display, 'Last Ten Games', 'lastTenGames'),
                    stats: display,
                    statValues: values,
                    fetchedAt: ctx.fetchedAt,
                });
            });
        }
        for (const child of node.children || []) walk(child, [...ancestors, node]);
    };
    walk(root, []);
    return rows;
}

function rankingsRows(ctx, data) {
    const rows = [];
    for (const poll of data?.rankings || []) {
        const sections = [['ranked', poll.ranks], ['others', poll.others], ['droppedOut', poll.droppedOut]];
        for (const [section, list] of sections) {
            for (const r of list || []) {
                const team = r.team ? teamOf(r.team) : null;
                const a = r.athlete || null;
                rows.push({
                    recordType: 'ranking',
                    sport: ctx.sport,
                    league: ctx.league,
                    leagueName: ctx.leagueName ?? null,
                    pollId: str(poll.id),
                    poll: poll.name ?? null,
                    pollShortName: poll.shortName ?? null,
                    pollType: poll.type ?? null,
                    headline: poll.shortHeadline ?? poll.headline ?? null,
                    date: isoUtc(poll.date ?? poll.update ?? poll.lastUpdated),
                    week: poll.occurrence?.displayValue ?? (poll.occurrence?.number !== undefined ? String(poll.occurrence.number) : null),
                    seasonYear: num(poll.season?.year ?? data.latestSeason?.year),
                    section,
                    rank: num(r.current),
                    previous: num(r.previous),
                    trend: r.trend ?? null,
                    points: num(r.points),
                    firstPlaceVotes: num(r.firstPlaceVotes),
                    recordSummary: r.recordSummary ?? null,
                    teamId: team?.id ?? null,
                    team: team?.displayName ?? (r.team ? `${r.team.location ?? ''} ${r.team.name ?? ''}`.trim() : null),
                    teamAbbr: team?.abbreviation ?? null,
                    teamLogo: team?.logo ?? null,
                    athleteId: str(a?.id),
                    athlete: a?.displayName ?? null,
                    athleteCountry: a?.citizenshipCountry ?? a?.flagAltText ?? a?.flag?.alt ?? null,
                    age: num(a?.age),
                    fetchedAt: ctx.fetchedAt,
                });
            }
        }
    }
    return rows;
}

function teamRow(ctx, t, detail) {
    const row = {
        recordType: 'team',
        sport: ctx.sport,
        league: ctx.league,
        leagueName: ctx.leagueName ?? null,
        teamId: str(t.id),
        uid: t.uid ?? null,
        slug: t.slug ?? null,
        abbreviation: t.abbreviation ?? null,
        displayName: t.displayName ?? null,
        shortDisplayName: t.shortDisplayName ?? null,
        location: t.location ?? null,
        name: t.name ?? null,
        nickname: t.nickname ?? null,
        color: t.color ?? null,
        alternateColor: t.alternateColor ?? null,
        logo: t.logos?.find((l) => (l.rel || []).includes('default'))?.href ?? t.logos?.[0]?.href ?? t.logo ?? null,
        logoDark: t.logos?.find((l) => (l.rel || []).includes('dark'))?.href ?? null,
        isActive: typeof t.isActive === 'boolean' ? t.isActive : null,
        isAllStar: typeof t.isAllStar === 'boolean' ? t.isAllStar : null,
        url: pick(t.links, (l) => (l.rel || []).includes('clubhouse'))?.href ?? t.links?.[0]?.href ?? null,
        venue: null,
        record: null,
        recordItems: null,
        standingSummary: null,
        groupId: null,
        conferenceId: null,
        nextEvent: null,
        fetchedAt: ctx.fetchedAt,
    };
    if (detail) {
        const d = detail;
        row.venue = venueOf(d.franchise?.venue ?? d.venue);
        row.record = d.record?.items?.find((i) => i.type === 'total')?.summary ?? d.record?.items?.[0]?.summary ?? null;
        row.recordItems = Array.isArray(d.record?.items) ? Object.fromEntries(d.record.items.map((i) => [i.type || i.description, i.summary])) : null;
        row.standingSummary = d.standingSummary ?? null;
        row.groupId = str(d.groups?.id);
        row.conferenceId = str(d.groups?.parent?.id);
        const ne = d.nextEvent?.[0];
        row.nextEvent = ne ? { eventId: str(ne.id), date: isoUtc(ne.date), name: ne.name ?? null, shortName: ne.shortName ?? null } : null;
    }
    return row;
}

function rosterRows(ctx, data, teamParam) {
    const team = teamOf(data.team) || { id: teamParam, displayName: null, abbreviation: null };
    const coach = data.coach?.[0] ? `${data.coach[0].firstName ?? ''} ${data.coach[0].lastName ?? ''}`.trim() || null : null;
    const groups = [];
    for (const a of data.athletes || []) {
        if (Array.isArray(a.items)) groups.push([a.position ?? null, a.items]);
        else groups.push([null, [a]]);
    }
    const rows = [];
    for (const [positionGroup, list] of groups) {
        for (const p of list) {
            rows.push({
                recordType: 'player',
                sport: ctx.sport,
                league: ctx.league,
                leagueName: ctx.leagueName ?? null,
                teamId: team.id,
                team: team.displayName ?? data.team?.displayName ?? null,
                teamAbbr: team.abbreviation ?? null,
                teamRecord: data.team?.recordSummary ?? null,
                teamStanding: data.team?.standingSummary ?? null,
                headCoach: coach,
                seasonYear: num(data.season?.year),
                athleteId: str(p.id),
                fullName: p.fullName ?? p.displayName ?? null,
                firstName: p.firstName ?? null,
                lastName: p.lastName ?? null,
                shortName: p.shortName ?? null,
                jersey: p.jersey ?? null,
                position: p.position?.displayName ?? p.position?.name ?? null,
                positionAbbr: p.position?.abbreviation ?? null,
                positionGroup,
                age: num(p.age),
                dateOfBirth: p.dateOfBirth ? String(p.dateOfBirth).slice(0, 10) : null,
                height: num(p.height),
                displayHeight: p.displayHeight ?? null,
                weight: num(p.weight),
                displayWeight: p.displayWeight ?? null,
                birthCity: p.birthPlace?.city ?? null,
                birthState: p.birthPlace?.state ?? null,
                birthCountry: p.birthPlace?.country ?? null,
                citizenship: p.citizenship ?? null,
                college: p.college?.name ?? null,
                experienceYears: num(p.experience?.years),
                status: p.status?.name ?? p.status?.type ?? null,
                injuryStatus: p.injuries?.[0]?.status ?? null,
                injuryDate: isoUtc(p.injuries?.[0]?.date),
                contract: p.contracts?.[0] ? { salary: num(p.contracts[0].salary), active: p.contracts[0].active ?? null, season: num(p.contracts[0].season?.year) } : null,
                headshot: p.headshot?.href ?? null,
                url: pick(p.links, (l) => (l.rel || []).includes('playercard'))?.href ?? p.links?.[0]?.href ?? null,
                fetchedAt: ctx.fetchedAt,
            });
        }
    }
    return rows;
}

function injuryRows(ctx, data) {
    const rows = [];
    for (const t of data?.injuries || []) {
        for (const inj of t.injuries || []) {
            const a = inj.athlete || {};
            rows.push({
                recordType: 'injury',
                sport: ctx.sport,
                league: ctx.league,
                leagueName: ctx.leagueName ?? null,
                injuryId: str(inj.id),
                teamId: str(t.id ?? a.team?.id),
                team: t.displayName ?? a.team?.displayName ?? null,
                teamAbbr: a.team?.abbreviation ?? null,
                athleteId: str(a.id ?? pick(a.links, () => true)?.href?.match(/\/id\/(\d+)/)?.[1]),
                athlete: a.displayName ?? null,
                position: a.position?.abbreviation ?? null,
                status: inj.status ?? null,
                statusType: inj.type?.description ?? inj.type?.name ?? null,
                statusAbbr: inj.type?.abbreviation ?? null,
                date: isoUtc(inj.date),
                injuryType: inj.details?.type ?? null,
                location: inj.details?.location ?? null,
                detail: inj.details?.detail ?? null,
                side: inj.details?.side ?? null,
                returnDate: inj.details?.returnDate ?? null,
                fantasyStatus: inj.details?.fantasyStatus?.description ?? null,
                shortComment: inj.shortComment ?? null,
                longComment: inj.longComment ?? null,
                headshot: a.headshot?.href ?? null,
                url: pick(a.links, (l) => (l.rel || []).includes('playercard'))?.href ?? null,
                fetchedAt: ctx.fetchedAt,
            });
        }
    }
    return rows;
}

function articleRows(ctx, data, extra = {}) {
    const rows = [];
    for (const a of data?.articles || []) {
        const cats = Array.isArray(a.categories) ? a.categories : [];
        const byType = (type, key) => uniq(cats.filter((c) => c.type === type).map((c) => c[key]?.description ?? c.description ?? null));
        const img = a.images?.find((i) => i.type === 'header') ?? a.images?.[0];
        rows.push({
            recordType: 'article',
            sport: ctx.sport,
            league: ctx.league,
            leagueName: ctx.leagueName ?? null,
            articleId: str(a.id),
            type: a.type ?? null,
            headline: a.headline ?? null,
            description: a.description ?? null,
            byline: a.byline ?? null,
            published: isoUtc(a.published),
            lastModified: isoUtc(a.lastModified),
            premium: typeof a.premium === 'boolean' ? a.premium : null,
            url: a.links?.web?.href ?? a.links?.mobile?.href ?? null,
            image: img?.url ?? null,
            imageCaption: img?.caption ?? null,
            teams: byType('team', 'team'),
            athletes: byType('athlete', 'athlete'),
            leagues: byType('league', 'league'),
            topics: uniq(cats.filter((c) => c.type === 'topic').map((c) => c.description)),
            fetchedAt: ctx.fetchedAt,
            ...extra,
        });
    }
    return rows;
}

// ---------- game summaries ----------

const compactPlay = (p) => ({
    id: str(p.id),
    sequence: num(p.sequenceNumber),
    period: num(p.period?.number),
    periodText: p.period?.displayValue ?? null,
    clock: p.clock?.displayValue ?? null,
    type: p.type?.text ?? null,
    text: p.text ?? p.shortText ?? null,
    teamId: str(p.team?.id),
    homeScore: num(p.homeScore),
    awayScore: num(p.awayScore),
    scoringPlay: typeof p.scoringPlay === 'boolean' ? p.scoringPlay : null,
    scoreValue: num(p.scoreValue),
    athleteIds: Array.isArray(p.participants) ? p.participants.map((x) => str(x.athlete?.id)).filter(Boolean) : (Array.isArray(p.athletesInvolved) ? p.athletesInvolved.map((x) => str(x.id)).filter(Boolean) : null),
    wallclock: p.wallclock ?? null,
});

function playersOf(boxscore) {
    const out = [];
    for (const sideBox of boxscore?.players || []) {
        const team = teamOf(sideBox.team);
        for (const group of sideBox.statistics || []) {
            const keys = group.keys || group.names || group.labels || [];
            for (const a of group.athletes || []) {
                const stats = {};
                keys.forEach((k, i) => { stats[k] = a.stats?.[i] ?? null; });
                out.push({
                    teamId: team?.id ?? null,
                    teamAbbr: team?.abbreviation ?? null,
                    statGroup: group.type ?? group.name ?? null,
                    athleteId: str(a.athlete?.id),
                    athlete: a.athlete?.displayName ?? null,
                    jersey: a.athlete?.jersey ?? null,
                    position: a.athlete?.position?.abbreviation ?? a.position?.abbreviation ?? null,
                    starter: typeof a.starter === 'boolean' ? a.starter : null,
                    didNotPlay: typeof a.didNotPlay === 'boolean' ? a.didNotPlay : null,
                    reason: a.reason ?? null,
                    ejected: typeof a.ejected === 'boolean' ? a.ejected : null,
                    batOrder: num(a.batOrder),
                    stats,
                });
            }
        }
    }
    return out;
}

function lineupsOf(rosters) {
    if (!Array.isArray(rosters)) return null;
    const out = [];
    for (const r of rosters) {
        if (!Array.isArray(r.roster)) continue;
        const team = teamOf(r.team);
        out.push({
            teamId: team?.id ?? null,
            teamAbbr: team?.abbreviation ?? null,
            homeAway: r.homeAway ?? null,
            formation: r.formation ?? null,
            players: r.roster.map((p) => ({
                athleteId: str(p.athlete?.id),
                athlete: p.athlete?.displayName ?? null,
                jersey: p.jersey ?? null,
                position: p.position?.abbreviation ?? null,
                starter: typeof p.starter === 'boolean' ? p.starter : null,
                subbedIn: typeof p.subbedIn === 'boolean' ? p.subbedIn : null,
                subbedOut: typeof p.subbedOut === 'boolean' ? p.subbedOut : null,
                formationPlace: p.formationPlace ?? null,
                stats: Array.isArray(p.stats) ? Object.fromEntries(p.stats.map((s) => [s.abbreviation || s.name, s.displayValue ?? s.value ?? null])) : null,
            })),
        });
    }
    return out.length ? out : null;
}

function summaryRow(ctx, id, s, opts) {
    const header = s.header || {};
    const comp = header.competitions?.[0] || {};
    const event = { id: header.id ?? id, uid: header.uid, name: comp.competitors?.length === 2 ? `${pick(comp.competitors, (c) => c.homeAway === 'away')?.team?.displayName ?? ''} at ${pick(comp.competitors, (c) => c.homeAway === 'home')?.team?.displayName ?? ''}` : (header.name ?? null), shortName: header.shortName ?? null, date: comp.date, season: header.season, week: header.week !== undefined ? { number: header.week } : undefined, links: header.links, status: comp.status };
    const row = competitionRow({ ...ctx, leagueName: header.league?.name ?? ctx.leagueName }, event, { ...comp, venue: s.gameInfo?.venue ?? comp.venue, attendance: s.gameInfo?.attendance ?? comp.attendance });
    row.recordType = 'gameSummary';
    row.gameNote = header.gameNote ?? null;
    row.seasonType = num(header.season?.type) ?? row.seasonType;
    const teams = s.boxscore?.teams || [];
    const bySide = (ha) => teams.find((t) => t.homeAway === ha) ?? teams[ha === 'home' ? 1 : 0] ?? null;
    const teamStats = (t) => (t ? Object.fromEntries((t.statistics || []).map((x) => [x.name || x.label, x.displayValue ?? x.value ?? null])) : null);
    row.teamStats = opts.includeBoxScore && teams.length ? { home: teamStats(bySide('home')), away: teamStats(bySide('away')) } : null;
    row.players = opts.includeBoxScore ? playersOf(s.boxscore) : null;
    row.lineups = opts.includeBoxScore ? lineupsOf(s.rosters) : null;
    row.leaders = [];
    for (const g of s.leaders || []) row.leaders.push(...leadersOf(g.leaders, teamOf(g.team)));
    const plays = Array.isArray(s.plays) ? s.plays : [];
    const keyEvents = Array.isArray(s.keyEvents) ? s.keyEvents : [];
    const scoring = Array.isArray(s.scoringPlays) ? s.scoringPlays : (plays.length ? plays.filter((p) => p.scoringPlay) : keyEvents.filter((p) => p.scoringPlay));
    row.scoringPlays = scoring.map((p) => ({ ...compactPlay(p), scoringPlay: true }));
    row.keyEvents = keyEvents.length ? keyEvents.map((e) => ({ ...compactPlay(e), typeSlug: e.type?.type ?? null, shootout: e.shootout ?? null, redCard: e.redCard ?? null, yellowCard: e.yellowCard ?? null, penaltyKick: e.penaltyKick ?? null, ownGoal: e.ownGoal ?? null })) : null;
    row.playCount = plays.length || null;
    row.plays = opts.includePlayByPlay && plays.length ? plays.slice(0, opts.maxPlays).map(compactPlay) : null;
    const drives = s.drives ? [...(s.drives.previous || []), ...(s.drives.current ? [s.drives.current] : [])] : null;
    row.driveCount = drives ? drives.length : null;
    row.drives = opts.includePlayByPlay && drives ? drives.slice(0, opts.maxPlays).map((d) => ({ id: str(d.id), teamId: str(d.team?.id), teamAbbr: d.team?.abbreviation ?? null, description: d.description ?? null, startPeriod: num(d.start?.period?.number), startClock: d.start?.clock?.displayValue ?? null, startYardLine: num(d.start?.yardLine), endPeriod: num(d.end?.period?.number), endClock: d.end?.clock?.displayValue ?? null, yards: num(d.yards), plays: num(d.offensivePlays), timeElapsed: d.timeElapsed?.displayValue ?? null, result: d.displayResult ?? d.result ?? null, isScore: typeof d.isScore === 'boolean' ? d.isScore : null })) : null;
    row.commentary = opts.includePlayByPlay && Array.isArray(s.commentary) ? s.commentary.slice(0, opts.maxPlays).map((c) => ({ sequence: num(c.sequence), time: c.time?.displayValue ?? null, text: c.text ?? null })) : null;
    const lines = (s.pickcenter || []).map(oddsOf).filter(Boolean);
    row.odds = lines[0] ?? null;
    row.oddsLines = lines.length ? lines : null;
    const wp = Array.isArray(s.winprobability) ? s.winprobability : [];
    const last = wp[wp.length - 1];
    row.winProbability = last ? { homeWinPercentage: num(last.homeWinPercentage), awayWinPercentage: last.homeWinPercentage !== undefined ? Number((1 - last.homeWinPercentage - (last.tiePercentage || 0)).toFixed(4)) : null, tiePercentage: num(last.tiePercentage), points: wp.length } : null;
    row.winProbabilityTimeline = opts.includePlayByPlay && wp.length ? wp.slice(0, opts.maxPlays).map((w) => ({ playId: str(w.playId), homeWinPercentage: num(w.homeWinPercentage) })) : null;
    row.injuries = [];
    for (const t of s.injuries || []) for (const inj of t.injuries || []) row.injuries.push({ teamId: str(t.team?.id), teamAbbr: t.team?.abbreviation ?? null, athleteId: str(inj.athlete?.id), athlete: inj.athlete?.displayName ?? null, position: inj.athlete?.position?.abbreviation ?? null, status: inj.status ?? null, date: isoUtc(inj.date), type: inj.details?.type ?? inj.type?.description ?? null, detail: inj.details?.detail ?? null, returnDate: inj.details?.returnDate ?? null });
    row.officials = (s.gameInfo?.officials || []).map((o) => ({ name: o.displayName ?? o.fullName ?? null, position: o.position?.displayName ?? o.position?.name ?? null }));
    row.weather = s.gameInfo?.weather ? { temperature: num(s.gameInfo.weather.temperature), condition: s.gameInfo.weather.conditionId ?? s.gameInfo.weather.displayValue ?? null, highTemperature: num(s.gameInfo.weather.highTemperature), lowTemperature: num(s.gameInfo.weather.lowTemperature) } : null;
    const series = s.seasonseries?.[0];
    row.seasonSeries = series ? { title: series.title ?? null, summary: series.summary ?? null, completed: series.completed ?? null } : null;
    row.broadcasts = broadcastsOf(comp).length ? broadcastsOf(comp) : (Array.isArray(s.broadcasts) ? uniq(s.broadcasts.map((b) => b.media?.shortName ?? b.shortName ?? null)) : row.broadcasts);
    row.headline = s.article?.headline ?? row.headline ?? null;
    row.articleUrl = s.article?.links?.web?.href ?? null;
    // Cricket: innings scorecards instead of a box score.
    if (Array.isArray(s.matchcards) && s.matchcards.length) {
        row.innings = s.matchcards.map((m) => ({ inningsNumber: num(m.inningsNumber), team: m.teamName ?? null, headline: m.headline ?? null, runs: num(m.runs), total: m.total ?? null, extras: m.extras ?? null, players: (m.playerDetails || []).map((p) => ({ athleteId: str(p.playerID), athlete: p.playerName ?? null, dismissal: p.dismissal ?? null, runs: num(p.runs), ballsFaced: num(p.ballsFaced), fours: num(p.fours), sixes: num(p.sixes) })) }));
        row.notes = Array.isArray(s.notes) ? s.notes.map((n) => n.text ?? n.headline ?? null).filter(Boolean) : null;
    }
    return row;
}

function fightcenterRow(ctx, id, fc) {
    const ev = fc.event || {};
    const cards = Object.values(fc.cards || {});
    const fights = [];
    for (const card of cards) {
        for (const c of card.competitions || []) {
            const status = statusOf(c.status);
            fights.push({
                competitionId: str(c.id),
                card: card.displayName ?? card.name ?? null,
                matchNumber: num(c.matchNumber),
                weightClass: c.type?.text ?? c.type?.abbreviation ?? null,
                note: c.note ?? null,
                date: isoUtc(c.date),
                status: status.state,
                statusDetail: status.detail,
                round: status.period,
                clock: status.clock,
                resultMethod: c.status?.result?.displayName ?? null,
                resultDescription: c.status?.result?.displayDescription ?? c.status?.result?.description ?? null,
                resultTarget: c.status?.result?.target?.displayDescription ?? null,
                competitors: (c.competitors || []).map((x) => ({ athleteId: str(x.athlete?.id ?? x.id), name: x.athlete?.displayName ?? x.athlete?.fullName ?? null, country: x.athlete?.country ?? x.athlete?.flag?.alt ?? null, order: num(x.order), winner: typeof x.winner === 'boolean' ? x.winner : null, record: x.displayRecord ?? null, age: num(x.athlete?.age), height: x.athlete?.displayHeight ?? null, weight: x.athlete?.displayWeight ?? null, reach: x.athlete?.displayReach ?? null, stance: x.athlete?.stance?.text ?? null, stats: Array.isArray(x.stats) ? Object.fromEntries(x.stats.map((s) => [s.name, s.value ?? s.displayValue ?? null])) : null })),
                officials: (c.officials || []).map((o) => ({ name: `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || null, position: o.position?.displayName ?? o.position?.name ?? null })),
                broadcasts: uniq((card.broadcasts || []).map((b) => b.media?.shortName ?? b.media?.name ?? b.slug ?? null)),
            });
        }
    }
    fights.sort((a, b) => (a.matchNumber ?? 0) - (b.matchNumber ?? 0));
    const main = fights.find((f) => /main event/i.test(f.note || '')) ?? fights[0] ?? null;
    const date = isoUtc(ev.date);
    return {
        recordType: 'gameSummary',
        sport: ctx.sport,
        league: ctx.league,
        leagueName: ctx.leagueName ?? null,
        eventId: str(ev.id ?? id),
        competitionId: str(ev.id ?? id),
        uid: ev.uid ?? null,
        name: ev.name ?? null,
        shortName: ev.shortName ?? null,
        date,
        dateLocal: localDateTime(date, ctx.timezone),
        timezone: ctx.timezone,
        seasonYear: num(fc.season?.year),
        status: fc.meta?.gameState ?? null,
        statusDetail: null,
        completed: fc.meta?.gameState === 'post' ? true : (fc.meta?.gameState ? false : null),
        venue: venueOf(fc.venue),
        venueName: fc.venue?.fullName ?? null,
        mainEvent: main ? main.competitors.map((c) => c.name).join(' vs ') : null,
        fightCount: fights.length,
        fights,
        broadcasts: uniq(fights.flatMap((f) => f.broadcasts)),
        lastUpdated: isoUtc(fc.meta?.lastUpdatedAt),
        url: `https://www.espn.com/mma/fightcenter/_/id/${ev.id ?? id}/league/${ctx.league}`,
        fetchedAt: ctx.fetchedAt,
    };
}

function leaderboardRow(ctx, id, ev) {
    const comp = ev.competitions?.[0] || {};
    const status = statusOf(ev.status ?? comp.status);
    const leaderboard = (comp.competitors || []).slice().sort((a, b) => (num(a.sortOrder) ?? 0) - (num(b.sortOrder) ?? 0)).map((c) => ({
        position: c.status?.position?.displayName ?? null,
        positionNumber: num(c.status?.position?.id),
        tie: typeof c.status?.position?.isTie === 'boolean' ? c.status.position.isTie : null,
        sortOrder: num(c.sortOrder),
        athleteId: str(c.athlete?.id ?? c.id),
        athlete: c.athlete?.displayName ?? null,
        country: c.athlete?.flag?.alt ?? null,
        amateur: typeof c.amateur === 'boolean' ? c.amateur : null,
        toPar: c.score?.displayValue ?? null,
        strokes: num(c.score?.value),
        thru: num(c.status?.thru),
        displayThru: c.status?.displayThru ?? c.status?.displayValue ?? null,
        currentRound: num(c.status?.period),
        status: c.status?.type?.description ?? null,
        teeTime: isoUtc(c.status?.teeTime),
        movement: num(c.movement),
        earnings: num(c.earnings),
        rounds: (c.linescores || []).map((l) => ({ round: num(l.period), strokes: num(l.value), toPar: l.displayValue ?? null })),
        stats: Array.isArray(c.statistics) ? Object.fromEntries(c.statistics.map((s) => [s.name, s.value ?? s.displayValue ?? null])) : null,
    }));
    const course = ev.courses?.[0];
    const date = isoUtc(ev.date);
    return {
        recordType: 'gameSummary',
        sport: ctx.sport,
        league: ctx.league,
        leagueName: ev.league?.name ?? ctx.leagueName ?? null,
        eventId: str(ev.id ?? id),
        competitionId: str(comp.id ?? ev.id ?? id),
        uid: ev.uid ?? null,
        name: ev.name ?? null,
        shortName: ev.shortName ?? null,
        date,
        dateLocal: localDateTime(date, ctx.timezone),
        timezone: ctx.timezone,
        endDate: isoUtc(ev.endDate),
        seasonYear: num(ev.season?.year),
        seasonType: num(ev.seasonType?.id),
        status: status.state,
        statusDetail: status.detail ?? status.description,
        completed: status.completed,
        tournamentId: str(ev.tournament?.id),
        tournament: ev.tournament?.displayName ?? null,
        major: typeof ev.tournament?.major === 'boolean' ? ev.tournament.major : null,
        numberOfRounds: num(ev.tournament?.numberOfRounds),
        cutRound: num(ev.tournament?.cutRound),
        cutScore: num(ev.tournament?.cutScore),
        purse: num(ev.purse),
        displayPurse: ev.displayPurse ?? null,
        defendingChampion: ev.defendingChampion?.athlete?.displayName ?? null,
        course: course ? { id: str(course.id), name: course.name ?? null, totalYards: num(course.totalYards), par: num(course.shotsToPar), city: course.address?.city ?? null, state: course.address?.state ?? null, country: course.address?.country ?? null } : null,
        venueName: course?.name ?? null,
        broadcasts: broadcastsOf(comp),
        leader: leaderboard[0] ? { athlete: leaderboard[0].athlete, toPar: leaderboard[0].toPar, position: leaderboard[0].position } : null,
        competitorCount: leaderboard.length,
        leaderboard,
        url: gamecastUrl(ev.links) ?? `https://www.espn.com/golf/leaderboard?tournamentId=${id}`,
        fetchedAt: ctx.fetchedAt,
    };
}

function eventDetailRow(ctx, event) {
    // Tennis tournaments and race weekends: the scoreboard event carries every match or session; one summary row with all of them.
    const rows = eventRows(ctx, event);
    const first = rows[0] || competitionRow(ctx, event, { id: event.id, status: event.status, competitors: [] });
    const date = isoUtc(event.date);
    return {
        ...first,
        recordType: 'gameSummary',
        competitionId: str(event.id),
        date,
        dateLocal: localDateTime(date, ctx.timezone),
        endDate: isoUtc(event.endDate),
        competitionType: null,
        round: null,
        grouping: null,
        homeTeamId: null, homeTeam: null, homeAbbr: null, homeScore: null, homeScoreText: null, homeWinner: null, homeRecord: null, homeLinescores: null, homeLogo: null,
        awayTeamId: null, awayTeam: null, awayAbbr: null, awayScore: null, awayScoreText: null, awayWinner: null, awayRecord: null, awayLinescores: null, awayLogo: null,
        winnerId: null,
        competitors: null,
        status: statusOf(event.status).state,
        statusDetail: statusOf(event.status).detail,
        completed: statusOf(event.status).completed,
        major: typeof event.major === 'boolean' ? event.major : null,
        venueName: event.venue?.displayName ?? event.circuit?.fullName ?? first.venueName ?? null,
        circuit: event.circuit ? { id: str(event.circuit.id), name: event.circuit.fullName ?? null, city: event.circuit.address?.city ?? null, country: event.circuit.address?.country ?? null } : null,
        previousWinners: Array.isArray(event.previousWinners) ? event.previousWinners.map((w) => ({ name: w.displayName ?? null, type: w.type?.text ?? null })) : null,
        competitionCount: rows.length,
        competitions: rows.map((r) => ({ competitionId: r.competitionId, date: r.date, competitionType: r.competitionType, round: r.round, grouping: r.grouping, status: r.status, statusDetail: r.statusDetail, period: r.period, clock: r.clock, court: r.court, note: r.note, homeTeamId: r.homeTeamId, homeTeam: r.homeTeam, homeScore: r.homeScore, homeLinescores: r.homeLinescores, homeWinner: r.homeWinner, awayTeamId: r.awayTeamId, awayTeam: r.awayTeam, awayScore: r.awayScore, awayLinescores: r.awayLinescores, awayWinner: r.awayWinner, winnerId: r.winnerId, competitors: r.competitors, broadcasts: r.broadcasts })),
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

// ---------- input parsing ----------

function parseEventIds(values, leagues) {
    const out = [];
    for (const raw of values) {
        const s = String(raw ?? '').trim();
        if (!s) continue;
        let leagueCode = null;
        let id = null;
        if (/^https?:\/\//i.test(s)) {
            const m = /\/(?:gameId|eventId|id)\/([\w-]+)/.exec(s) || /[?&](?:gameId|event|tournamentId)=([\w-]+)/.exec(s) || /\/fightcenter\/([\w-]+)/.exec(s) || /\/scorecard\/(\d+)/.exec(s);
            if (!m) throw new InputError(`eventIds: no event id found in URL "${s}".`);
            id = m[1];
            const sportPath = /espn\.com\/([a-z-]+)\//.exec(s)?.[1];
            const leaguePath = /\/league\/([a-z0-9.]+)/.exec(s)?.[1] || /\/series\/(\d+)\//.exec(s)?.[1];
            leagueCode = leaguePath || (sportPath && ALIASES[sportPath] ? sportPath : null);
        } else if (s.includes('/')) {
            const idx = s.lastIndexOf('/');
            leagueCode = s.slice(0, idx);
            id = s.slice(idx + 1);
        } else id = s;
        if (!/^[\w-]+$/.test(id)) throw new InputError(`eventIds: "${s}" is not an ESPN event id.`);
        let league;
        if (leagueCode) league = leagues.find((l) => l.code.toLowerCase() === leagueCode.toLowerCase() || l.league === leagueCode.toLowerCase() || l.key === leagueCode.toLowerCase()) ?? resolveLeague(leagueCode);
        else if (leagues.length === 1) league = leagues[0];
        else throw new InputError(`eventIds: "${s}" has no league prefix and several leagues are given; write it as league/id (nba/${id}).`);
        out.push({ league, id });
    }
    return out;
}

function parseTeams(values, leagues) {
    const out = [];
    for (const raw of values) {
        const s = String(raw ?? '').trim();
        if (!s) continue;
        if (s.includes('/')) {
            const idx = s.lastIndexOf('/');
            const code = s.slice(0, idx);
            const league = leagues.find((l) => l.code.toLowerCase() === code.toLowerCase() || l.league === code.toLowerCase() || l.key === code.toLowerCase()) ?? resolveLeague(code);
            out.push({ league, team: s.slice(idx + 1) });
        } else out.push({ league: null, team: s });
    }
    if (out.some((t) => !/^[\w .&'-]+$/.test(t.team))) throw new InputError('teams: entries must be ESPN team ids or abbreviations such as LAL, KC, ARS, 13 (optionally league/TEAM).');
    return out;
}

// ---------- main ----------

async function main() {
    const startedAt = Date.now();
    const input = (await Actor.getInput()) ?? {};
    const {
        mode = 'scoreboard',
        leagues: leagueCodes = [],
        dates = 'today',
        timezone = 'America/New_York',
        teams: teamInputs = [],
        eventIds = [],
        season,
        seasonType,
        groups,
        statusFilter = STATES,
        includeBoxScore = true,
        includePlayByPlay = false,
        maxPlays = 1000,
        allOddsProviders = false,
        includeTeamDetails = false,
        maxResults = 1000,
    } = input;

    if (!MODES.includes(mode)) throw new InputError(`mode must be one of ${MODES.join(', ')}.`);
    if (!Array.isArray(leagueCodes) || leagueCodes.length === 0 || leagueCodes.some((c) => typeof c !== 'string')) throw new InputError('leagues must be a non-empty list of league codes such as ["nba", "nfl", "epl", "soccer/ned.1"].');
    const leagues = [...new Map(leagueCodes.map(resolveLeague).filter(Boolean).map((l) => [l.key, l])).values()];
    if (!leagues.length) throw new InputError('leagues is empty after trimming.');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
        throw new InputError(`timezone "${timezone}" is not an IANA time zone (America/New_York, Europe/London, Asia/Seoul ...).`);
    }
    const parsedDates = parseDates(dates, timezone);
    if (!Array.isArray(teamInputs) || teamInputs.some((t) => typeof t !== 'string')) throw new InputError('teams must be a list of strings.');
    const teams = parseTeams(teamInputs, leagues);
    if (!Array.isArray(eventIds) || eventIds.some((t) => typeof t !== 'string')) throw new InputError('eventIds must be a list of strings.');
    if (season !== undefined && season !== null && (!Number.isInteger(season) || season < 1990 || season > 2100)) throw new InputError('season must be a year such as 2025.');
    if (seasonType !== undefined && seasonType !== null && (!Number.isInteger(seasonType) || seasonType < 1 || seasonType > 4)) throw new InputError('seasonType must be 1 (preseason), 2 (regular season), 3 (postseason) or 4 (off-season).');
    if (groups !== undefined && groups !== null && groups !== '' && !/^\d+$/.test(String(groups))) throw new InputError('groups must be a numeric ESPN group id such as 80 (FBS) or 50 (Division I).');
    if (!Array.isArray(statusFilter) || statusFilter.length === 0 || statusFilter.some((s) => !STATES.includes(s))) throw new InputError('statusFilter must be a non-empty list of "pre", "in", "post".');
    if (!Number.isInteger(maxPlays) || maxPlays < 1 || maxPlays > 5000) throw new InputError('maxPlays must be an integer between 1 and 5000.');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new InputError(`maxResults must be an integer between 1 and ${MAX_RESULTS_CAP}.`);
    if (mode === 'game' && eventIds.filter((e) => String(e).trim()).length === 0) throw new InputError('game mode needs at least one entry in eventIds (nba/401902645, a bare id when one league is given, or an ESPN gamecast URL).');
    if (mode === 'roster' && teams.length === 0) throw new InputError('roster mode needs at least one entry in teams (ESPN team id or abbreviation, e.g. LAL, KC, ARS).');
    const events = mode === 'game' ? parseEventIds(eventIds, leagues) : [];

    const charger = await makeCharger();
    if ((await charger.charge('actor-start', 1)).limitReached) throw new Error('The run\'s maximum charge is below the actor-start price; raise the limit and retry.');

    const fetchedAt = new Date().toISOString();
    const stats = { requests: 0, retries: 0, failed: 0, rowsPushed: 0, rowsDeduped: 0, rowsFilteredOut: 0, charged: {}, rowsByLeague: {}, rowsByType: {} };
    const failures = [];
    const seen = new Set();
    let stopReason = null;
    const eventName = EVENT_NAME[mode];
    const statusSet = new Set(statusFilter);
    const teamCache = new Map(); // league key -> teams list (one request per league per run)

    const fail = (league, context, error) => {
        stats.failed++;
        failures.push({ league: league?.key ?? null, context, error: String(error?.message ?? error) });
        log.warning(`${league?.key ?? ''} ${context}: ${error?.message ?? error}`);
    };

    async function pushCharged(rows, league, idOf) {
        if (!rows.length || stopReason) return;
        const fresh = [];
        for (const r of rows) {
            const key = `${r.recordType}:${league?.key ?? r.league}:${idOf(r)}`;
            if (seen.has(key)) { stats.rowsDeduped++; continue; }
            seen.add(key);
            fresh.push(r);
        }
        const room = maxResults - stats.rowsPushed;
        const batch = fresh.slice(0, Math.max(0, room));
        if (fresh.length > room) stopReason = `maxResults (${maxResults}) reached`;
        if (!batch.length) return;
        const { allowed, limitReached } = await charger.charge(eventName, batch.length);
        const slice = batch.slice(0, allowed);
        if (slice.length) {
            await Actor.pushData(slice);
            stats.rowsPushed += slice.length;
            stats.charged[eventName] = (stats.charged[eventName] || 0) + slice.length;
            const lk = league?.key ?? slice[0].league;
            stats.rowsByLeague[lk] = (stats.rowsByLeague[lk] || 0) + slice.length;
            stats.rowsByType[slice[0].recordType] = (stats.rowsByType[slice[0].recordType] || 0) + slice.length;
        }
        if (limitReached || allowed < batch.length) stopReason = `maximum charge reached (${eventName})`;
    }

    const ctxOf = (league, extra = {}) => ({ sport: league.sport, league: league.league, leagueName: null, timezone, fetchedAt, ...extra });
    const groupParam = (league) => {
        const g = groups !== undefined && groups !== null && groups !== '' ? String(groups) : league.collegeGroup;
        return g ? `&groups=${encodeURIComponent(g)}` : '';
    };
    const seasonParams = () => `${season ? `&season=${season}` : ''}${seasonType ? `&seasontype=${seasonType}` : ''}`;

    // Team filter for scoreboard/odds rows: ids, abbreviations or names, optionally scoped to a league.
    const teamMatcher = (league) => {
        const wanted = teams.filter((t) => !t.league || t.league.key === league.key).map((t) => t.team.toLowerCase());
        if (!wanted.length) return () => true;
        return (r) => {
            const hay = [r.homeTeamId, r.homeAbbr, r.homeTeam, r.awayTeamId, r.awayAbbr, r.awayTeam].filter(Boolean).map((x) => String(x).toLowerCase());
            return wanted.some((w) => hay.includes(w) || hay.some((h) => h.endsWith(` ${w}`)));
        };
    };

    async function loadTeams(league) {
        if (teamCache.has(league.key)) return teamCache.get(league.key);
        const j = await getJson(`${SITE}/${league.sport}/${league.league}/teams?limit=1000${groupParam(league)}`);
        const list = (j?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean);
        const info = { list, leagueName: j?.sports?.[0]?.leagues?.[0]?.name ?? null };
        teamCache.set(league.key, info);
        return info;
    }

    // Team endpoints take ids and (for US leagues) abbreviations; soccer and college codes need the id, so fall back to the cached team list.
    async function fetchTeamResource(league, team, resource) {
        const url = (t) => `${SITE}/${league.sport}/${league.league}/teams/${encodeURIComponent(t)}/${resource}`;
        let j = await getJson(url(team));
        if (j?.team) return j;
        const { list } = await loadTeams(league);
        const want = team.toLowerCase();
        const hit = list.find((t) => [t.id, t.abbreviation, t.slug, t.displayName, t.shortDisplayName, t.name, t.location].filter(Boolean).some((v) => String(v).toLowerCase() === want));
        if (hit && String(hit.id) !== team) j = await getJson(url(hit.id));
        return j?.team ? j : null;
    }

    async function scoreboardRowsFor(league, token, ctx) {
        const url = `${SITE}/${league.sport}/${league.league}/scoreboard?dates=${token}&limit=1000${groupParam(league)}`;
        const j = await getJson(url);
        if (!j) return null;
        ctx.leagueName = j.leagues?.[0]?.name ?? ctx.leagueName;
        ctx.week = j.week?.number;
        const rows = [];
        for (const ev of j.events || []) rows.push(...eventRows(ctx, ev));
        return rows;
    }

    // Scoreboard rows for every league and date token, filtered to the span, the status set and the team filter.
    async function collectScoreboard(onRows) {
        const tokens = dateTokens(parsedDates);
        const filterSpan = parsedDates.kind === 'days' && parsedDates.days.length > DAY_BY_DAY_LIMIT;
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            const match = teamMatcher(league);
            let any = false;
            for (const token of tokens) {
                if (stopReason) break;
                let rows;
                try {
                    rows = await scoreboardRowsFor(league, token, ctx);
                } catch (e) {
                    fail(league, `scoreboard ${token}`, e);
                    continue;
                }
                if (rows === null) {
                    if (token === tokens[0]) fail(league, `scoreboard ${token}`, new Error('ESPN returned no scoreboard for this league code (404); check the code or write it as sport/league'));
                    continue;
                }
                any = true;
                const before = rows.length;
                // Tennis tournaments, race weekends and fight cards come back whole on every day they span; keep the matches,
                // sessions and fights of the requested days. Golf stays one row per tournament. Long spans are filtered too.
                const perDay = filterSpan || (league.athlete && league.sport !== 'golf' && parsedDates.kind === 'days');
                const inSpan = (r) => !r.dateLocal || (r.dateLocal.slice(0, 10) >= parsedDates.from && r.dateLocal.slice(0, 10) <= parsedDates.to);
                rows = rows.filter((r) => statusSet.has(r.status) && match(r) && (!perDay || inSpan(r)));
                stats.rowsFilteredOut += before - rows.length;
                await onRows(league, rows, ctx);
            }
            if (!any) log.warning(`${league.key}: no scoreboard data for ${dates}`);
        }
    }

    log.info(`Mode ${mode} for ${leagues.map((l) => l.key).join(', ')}${['scoreboard', 'odds', 'schedule'].includes(mode) ? ` on ${dates} (${dateTokens(parsedDates).length} request${dateTokens(parsedDates).length === 1 ? '' : 's'} per league)` : ''}`);

    if (mode === 'scoreboard' || (mode === 'schedule' && teams.length === 0)) {
        await collectScoreboard((league, rows) => pushCharged(rows, league, (r) => r.competitionId));
    } else if (mode === 'schedule') {
        for (const league of leagues) {
            for (const t of teams) {
                if (stopReason) break;
                if (t.league && t.league.key !== league.key) continue;
                const ctx = ctxOf(league);
                try {
                    const j = await fetchTeamResource(league, t.team, `schedule?limit=1000${seasonParams()}`);
                    if (!j) { fail(league, `schedule ${t.team}`, new Error('team not found in this league')); continue; }
                    ctx.leagueName = j.team?.league?.name ?? null;
                    const team = teamOf(j.team);
                    let events = j.events || [];
                    // ESPN answers with the current phase only; during a preseason that is a handful of games, so add the regular season unless a type was asked for.
                    if (!seasonType && num(j.requestedSeason?.type) === 1 && j.requestedSeason?.year) {
                        const reg = await getJson(`${SITE}/${league.sport}/${league.league}/teams/${encodeURIComponent(team.id)}/schedule?limit=1000&season=${j.requestedSeason.year}&seasontype=2`);
                        if (reg?.events?.length) events = [...events, ...reg.events];
                    }
                    const rows = [];
                    for (const ev of events) {
                        for (const r of eventRows(ctx, ev)) {
                            if (!statusSet.has(r.status)) { stats.rowsFilteredOut++; continue; }
                            r.seasonYear = r.seasonYear ?? num(j.requestedSeason?.year ?? j.season?.year);
                            r.seasonType = r.seasonType ?? num(j.requestedSeason?.type ?? j.season?.type);
                            rows.push({ ...r, scheduleTeamId: team.id, scheduleTeam: team.displayName, scheduleTeamAbbr: team.abbreviation, scheduleHomeAway: r.homeTeamId === team.id ? 'home' : (r.awayTeamId === team.id ? 'away' : null), byeWeek: num(j.byeWeek) });
                        }
                    }
                    log.info(`${league.key} ${team.abbreviation ?? t.team}: ${rows.length} scheduled events (season ${j.requestedSeason?.year ?? j.season?.year ?? '-'})`);
                    await pushCharged(rows, league, (r) => `${r.scheduleTeamId}:${r.competitionId}`);
                } catch (e) {
                    fail(league, `schedule ${t.team}`, e);
                }
            }
        }
    } else if (mode === 'standings') {
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            try {
                const g = groups !== undefined && groups !== null && groups !== '' ? String(groups) : league.collegeGroup;
                const j = await getJson(`${WEB}/v2/sports/${league.sport}/${league.league}/standings?region=us&lang=en&level=3${seasonParams()}${g ? `&group=${encodeURIComponent(g)}` : ''}`);
                if (!j) { fail(league, 'standings', new Error('no standings for this league code')); continue; }
                const rows = standingsRows(ctx, j);
                if (!rows.length) log.warning(`${league.key}: standings table is empty (athlete sports and tournaments without a table return nothing)`);
                log.info(`${league.key}: ${rows.length} standings rows in ${uniq(rows.map((r) => r.group)).length} groups`);
                await pushCharged(rows, league, (r) => `${r.standingsName}:${r.groupId}:${r.teamId ?? r.athleteId}`);
            } catch (e) {
                fail(league, 'standings', e);
            }
        }
    } else if (mode === 'rankings') {
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            try {
                const j = await getJson(`${SITE}/${league.sport}/${league.league}/rankings?${season ? `season=${season}` : ''}`);
                if (!j) { fail(league, 'rankings', new Error('no rankings for this league code')); continue; }
                ctx.leagueName = j.leagues?.[0]?.name ?? null;
                const rows = rankingsRows(ctx, j);
                if (!rows.length) log.warning(`${league.key}: no rankings published (polls exist for college sports, tennis and UFC)`);
                log.info(`${league.key}: ${rows.length} ranking rows in ${uniq(rows.map((r) => r.poll)).length} polls`);
                await pushCharged(rows, league, (r) => `${r.pollId}:${r.section}:${r.teamId ?? r.athleteId}:${r.rank}`);
            } catch (e) {
                fail(league, 'rankings', e);
            }
        }
    } else if (mode === 'teams') {
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            try {
                const { list, leagueName } = await loadTeams(league);
                ctx.leagueName = leagueName;
                if (!list.length) { log.warning(`${league.key}: no teams listed (athlete sport or unknown league code)`); continue; }
                const rows = [];
                for (const t of list) {
                    if (stopReason || rows.length + stats.rowsPushed >= maxResults) break;
                    let detail = null;
                    if (includeTeamDetails) {
                        try {
                            detail = (await getJson(`${SITE}/${league.sport}/${league.league}/teams/${encodeURIComponent(t.id)}`))?.team ?? null;
                        } catch (e) {
                            fail(league, `team ${t.abbreviation ?? t.id}`, e);
                        }
                    }
                    rows.push(teamRow(ctx, t, detail));
                }
                log.info(`${league.key}: ${rows.length} teams`);
                await pushCharged(rows, league, (r) => r.teamId);
            } catch (e) {
                fail(league, 'teams', e);
            }
        }
    } else if (mode === 'roster') {
        for (const league of leagues) {
            for (const t of teams) {
                if (stopReason) break;
                if (t.league && t.league.key !== league.key) continue;
                const ctx = ctxOf(league);
                try {
                    const j = await fetchTeamResource(league, t.team, 'roster');
                    if (!j?.athletes) { fail(league, `roster ${t.team}`, new Error('team not found in this league')); continue; }
                    const rows = rosterRows(ctx, j, t.team);
                    log.info(`${league.key} ${j.team?.abbreviation ?? t.team}: ${rows.length} players`);
                    await pushCharged(rows, league, (r) => `${r.teamId}:${r.athleteId}`);
                } catch (e) {
                    fail(league, `roster ${t.team}`, e);
                }
            }
        }
    } else if (mode === 'injuries') {
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            try {
                const j = await getJson(`${SITE}/${league.sport}/${league.league}/injuries`);
                if (!j) { fail(league, 'injuries', new Error('no injury report for this league code')); continue; }
                let rows = injuryRows(ctx, j);
                const match = teams.filter((x) => !x.league || x.league.key === league.key).map((x) => x.team.toLowerCase());
                if (match.length) rows = rows.filter((r) => match.includes(String(r.teamId).toLowerCase()) || match.includes(String(r.teamAbbr).toLowerCase()) || match.includes(String(r.team).toLowerCase()));
                if (!rows.length) log.warning(`${league.key}: no injuries listed (ESPN publishes injury reports for NFL, NBA, WNBA, MLB, NHL and some college football)`);
                log.info(`${league.key}: ${rows.length} injuries across ${uniq(rows.map((r) => r.teamId)).length} teams`);
                await pushCharged(rows, league, (r) => r.injuryId ?? `${r.athleteId}:${r.date}`);
            } catch (e) {
                fail(league, 'injuries', e);
            }
        }
    } else if (mode === 'news') {
        for (const league of leagues) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            const limit = Math.min(Math.max(maxResults - stats.rowsPushed, 1), 100);
            const scoped = teams.filter((x) => !x.league || x.league.key === league.key);
            const targets = scoped.length ? scoped.map((x) => x.team) : [null];
            for (const team of targets) {
                if (stopReason) break;
                try {
                    const j = await getJson(`${SITE}/${league.sport}/${league.league}/news?limit=${limit}${team ? `&team=${encodeURIComponent(team)}` : ''}`);
                    if (!j) { fail(league, `news${team ? ` ${team}` : ''}`, new Error('no news feed for this league code')); continue; }
                    const rows = articleRows(ctx, j, team ? { teamFilter: team } : {});
                    log.info(`${league.key}${team ? ` ${team}` : ''}: ${rows.length} articles`);
                    await pushCharged(rows, league, (r) => r.articleId);
                } catch (e) {
                    fail(league, `news${team ? ` ${team}` : ''}`, e);
                }
            }
        }
    } else if (mode === 'odds') {
        await collectScoreboard(async (league, rows, ctx) => {
            const out = [];
            for (const r of rows) {
                if (stopReason) break;
                const base = { recordType: 'odds', sport: r.sport, league: r.league, leagueName: r.leagueName, eventId: r.eventId, competitionId: r.competitionId, name: r.name, shortName: r.shortName, date: r.date, dateLocal: r.dateLocal, timezone: r.timezone, status: r.status, statusDetail: r.statusDetail, homeTeamId: r.homeTeamId, homeTeam: r.homeTeam, homeAbbr: r.homeAbbr, homeScore: r.homeScore, awayTeamId: r.awayTeamId, awayTeam: r.awayTeam, awayAbbr: r.awayAbbr, awayScore: r.awayScore, url: r.url, fetchedAt };
                let lines = r.odds ? [r.odds] : [];
                let source = 'scoreboard';
                if (allOddsProviders && !league.athlete) {
                    try {
                        const j = await getJson(`${CORE}/${league.sport}/leagues/${league.league}/events/${r.eventId}/competitions/${r.competitionId}/odds?limit=50`);
                        const items = (j?.items || []).map(oddsOf).filter(Boolean);
                        if (items.length) { lines = items; source = 'odds-feed'; }
                    } catch (e) {
                        fail(league, `odds ${r.eventId}`, e);
                    }
                }
                for (const line of lines) out.push({ ...base, source, ...line, moneylineWinner: r.status === 'post' ? line.moneylineWinner : null, spreadWinner: r.status === 'post' ? line.spreadWinner : null });
            }
            if (!out.length && rows.length) log.info(`${league.key}: ${rows.length} events on this day, none with a published line`);
            await pushCharged(out, league, (o) => `${o.competitionId}:${o.providerId ?? o.provider}`);
        });
    } else if (mode === 'game') {
        const todo = events.slice(0, maxResults);
        if (events.length > maxResults) stopReason = `maxResults (${maxResults}) reached`;
        const opts = { includeBoxScore, includePlayByPlay, maxPlays };
        for (const { league, id } of todo) {
            if (stopReason) break;
            const ctx = ctxOf(league);
            try {
                let row = null;
                if (league.sport === 'mma') {
                    const fc = await getJson(`${WEB}/common/v3/sports/mma/${league.league}/fightcenter/${encodeURIComponent(id)}?region=us&lang=en`);
                    if (fc?.cards) row = fightcenterRow(ctx, id, fc);
                } else if (league.sport === 'golf') {
                    const lb = await getJson(`${WEB}/site/v2/sports/golf/leaderboard?league=${league.league}&event=${encodeURIComponent(id)}&region=us&lang=en`);
                    if (lb?.events?.[0]) row = leaderboardRow(ctx, id, lb.events[0]);
                } else if (league.athlete) {
                    // Tennis and racing have no summary endpoint: find the event's date, then read it from that day's scoreboard.
                    const core = await getJson(`${CORE}/${league.sport}/leagues/${league.league}/events/${encodeURIComponent(id)}`);
                    const day = core?.date ? String(core.date).slice(0, 10).replace(/-/g, '') : null;
                    if (day) {
                        const sb = await getJson(`${SITE}/${league.sport}/${league.league}/scoreboard?dates=${day}`);
                        ctx.leagueName = sb?.leagues?.[0]?.name ?? null;
                        const ev = (sb?.events || []).find((e) => String(e.id) === String(id));
                        if (ev) row = eventDetailRow(ctx, ev);
                    }
                } else {
                    const s = await getJson(`${WEB}/site/v2/sports/${league.sport}/${league.league}/summary?event=${encodeURIComponent(id)}&region=us&lang=en`);
                    if (s?.header) row = summaryRow(ctx, id, s, opts);
                }
                if (!row) { fail(league, `game ${id}`, new Error('event not found for this league (check the id and the league prefix)')); continue; }
                log.info(`${league.key} ${id}: ${row.name ?? row.shortName ?? ''} (${row.status ?? '-'})${row.players ? `, ${row.players.length} player stat lines` : ''}${row.plays ? `, ${row.plays.length} plays` : ''}`);
                await pushCharged([row], league, (r) => r.eventId);
            } catch (e) {
                fail(league, `game ${id}`, e);
            }
        }
    }

    stats.requests = http.requests;
    stats.retries = http.retries;
    const summary = {
        finishedAt: new Date().toISOString(),
        durationSecs: Math.round((Date.now() - startedAt) / 100) / 10,
        stopReason: stopReason ?? 'completed',
        input: { mode, leagues: leagues.map((l) => l.key), dates, dateSpan: parsedDates.kind === 'days' ? `${parsedDates.from}..${parsedDates.to}` : parsedDates.tokens[0], timezone, teams: teamInputs, eventIds: eventIds.length, season: season ?? null, seasonType: seasonType ?? null, groups: groups ?? null, statusFilter, includeBoxScore, includePlayByPlay, maxPlays, allOddsProviders, includeTeamDetails, maxResults },
        stats,
        failures,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done in ${summary.durationSecs}s: ${stats.rowsPushed} rows, ${stats.requests} requests (${stats.retries} retries), ${stats.failed} failures; ${summary.stopReason}`);
    await Actor.setStatusMessage(`${stats.rowsPushed} rows (${mode}), ${stats.failed} failures`);
    if (stats.rowsPushed === 0 && stats.failed > 0) throw new Error(`Nothing could be fetched: ${failures.slice(0, 3).map((f) => `${f.league ?? ''} ${f.context}: ${f.error}`).join('; ')}`);
}

await Actor.main(async () => {
    try {
        await main();
    } finally {
        // Let keep-alive sockets settle before the SDK exits; Node 24 on Windows can otherwise abort with a libuv assertion.
        await sleep(300);
    }
});
