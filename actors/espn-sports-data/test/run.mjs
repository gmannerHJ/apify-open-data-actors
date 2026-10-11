// Local end-to-end test against ESPN's live public endpoints using the SDK's local storage (no Apify account needed).
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
    results.push({ name, exitCode: code, rows: rows.length, secs, requests: summary?.stats?.requests, failed: summary?.stats?.failed, stopReason: summary?.stopReason });
    console.log(`\n=== ${name}: exit ${code}, ${rows.length} rows in ${secs}s, requests=${summary?.stats?.requests}, failed=${summary?.stats?.failed}`);
    return { code, rows, summary, secs };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const yesterday = ymd(new Date(Date.now() - 86400e3));
const weekAgo = ymd(new Date(Date.now() - 7 * 86400e3));
const EVENT_FIELDS = ['recordType', 'sport', 'league', 'eventId', 'competitionId', 'name', 'shortName', 'date', 'dateLocal', 'timezone', 'seasonYear', 'status', 'statusDetail', 'completed', 'period', 'clock', 'homeTeamId', 'homeTeam', 'homeAbbr', 'homeScore', 'homeWinner', 'homeRecord', 'homeLinescores', 'awayTeamId', 'awayTeam', 'awayAbbr', 'awayScore', 'awayWinner', 'awayLinescores', 'winnerId', 'venue', 'venueName', 'broadcasts', 'odds', 'leaders', 'url', 'fetchedAt'];
const sample = (r, keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, r[k]])));
const discovered = {};

// 1. Scoreboard, yesterday, two US leagues: final games with scores, line scores, records and leaders.
{
    const { code, rows } = await runActor('scoreboard-yesterday-nba-nhl', { mode: 'scoreboard', leagues: ['nba', 'nhl'], dates: 'yesterday' });
    assert(code === 0, 'exit code 0');
    assert(rows.length > 0, `games found yesterday, got ${rows.length}`);
    for (const r of rows) assert(EVENT_FIELDS.every((f) => f in r), `fields present on ${r.eventId}: missing ${EVENT_FIELDS.filter((f) => !(f in r)).join(',')}`);
    assert(rows.every((r) => r.recordType === 'event' && r.homeTeamId && r.awayTeamId && r.homeAbbr && r.awayAbbr && /^\d{4}-\d{2}-\d{2}T/.test(r.date) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.dateLocal)), 'teams and dates on every row');
    const finals = rows.filter((r) => r.status === 'post');
    assert(finals.length > 0, 'at least one final');
    assert(finals.every((r) => typeof r.homeScore === 'number' && typeof r.awayScore === 'number' && Array.isArray(r.homeLinescores) && r.homeLinescores.length >= 3 && (r.homeWinner || r.awayWinner) && r.winnerId), 'finals carry scores, line scores and a winner');
    assert(finals.some((r) => r.leaders.length >= 3 && r.leaders[0].athleteId && typeof r.leaders[0].value === 'number'), 'leaders attached');
    assert(rows.every((r) => r.url && r.url.includes('espn.com')), 'gamecast urls');
    discovered.nba = rows.find((r) => r.league === 'nba' && r.status === 'post')?.eventId;
    discovered.nhl = rows.find((r) => r.league === 'nhl' && r.status === 'post')?.eventId;
    console.log('  sample:', sample(finals[0], ['league', 'shortName', 'dateLocal', 'statusDetail', 'awayAbbr', 'awayScore', 'homeAbbr', 'homeScore', 'homeLinescores', 'homeRecord', 'venueName', 'broadcasts']));
}
// 2. Scoreboard, today, NFL and Premier League: upcoming games carry the featured sportsbook line, no fake zero scores.
{
    const { code, rows } = await runActor('scoreboard-today-nfl-epl', { mode: 'scoreboard', leagues: ['nfl', 'epl'], dates: 'today' });
    assert(code === 0, 'exit code 0');
    const pre = rows.filter((r) => r.status === 'pre');
    assert(pre.every((r) => r.homeScore === null && r.awayScore === null), 'scheduled games have no score');
    const withOdds = rows.filter((r) => r.odds);
    if (rows.length) assert(withOdds.length > 0, `some game has a line (${withOdds.length}/${rows.length})`);
    for (const r of withOdds) assert(r.odds.provider && typeof r.odds.homeSpread === 'number' && typeof r.odds.overUnder === 'number' && typeof r.odds.homeMoneyline === 'number' && r.odds.awaySpread === -r.odds.homeSpread, `line fields on ${r.shortName}: ${JSON.stringify(r.odds)}`);
    assert(rows.filter((r) => r.league === 'nfl').every((r) => typeof r.week === 'number'), 'NFL week number');
    discovered.epl = rows.find((r) => r.league === 'eng.1' && r.status === 'post')?.eventId;
    if (withOdds[0]) console.log('  sample odds:', sample(withOdds[0], ['league', 'shortName', 'status']), JSON.stringify(withOdds[0].odds));
}
// 3. Scoreboard for athlete sports: tennis matches of the day, the golf tournament, UFC fights, F1 sessions.
{
    const { code, rows } = await runActor('scoreboard-athletes-yesterday', { mode: 'scoreboard', leagues: ['atp', 'wta', 'pga', 'ufc', 'f1'], dates: 'yesterday' });
    assert(code === 0, 'exit code 0');
    const tennis = rows.filter((r) => r.sport === 'tennis');
    const golf = rows.filter((r) => r.sport === 'golf');
    const mma = rows.filter((r) => r.sport === 'mma');
    const f1 = rows.filter((r) => r.sport === 'racing');
    console.log(`  tennis=${tennis.length} golf=${golf.length} ufc=${mma.length} f1=${f1.length}`);
    for (const r of tennis) assert(r.tournament && r.grouping && r.round && r.competitorCount === 2 && Array.isArray(r.competitors) && r.competitors.length === 2 && r.dateLocal.slice(0, 10) === yesterday, `tennis match row ${r.competitionId} (${r.dateLocal}, ${r.round})`);
    for (const r of tennis.filter((x) => x.status === 'post')) assert(r.winnerId && Array.isArray(r.homeLinescores) && r.homeLinescores.length >= 2, `tennis final has set scores ${r.competitionId}`);
    for (const r of golf) assert(r.competitorCount > 30 && r.competitors[0].athleteId && typeof r.competitors[0].score === 'number', `golf tournament row with field (${r.name})`);
    for (const r of mma) assert(r.competitionType && r.competitors.length === 2 && r.homeTeam && r.awayTeam, `fight row ${r.competitionId}`);
    for (const r of f1) assert(r.competitionType && r.competitorCount >= 10, `F1 session row ${r.competitionType}`);
    if (tennis[0]) console.log('  sample tennis:', sample(tennis.find((r) => r.status === 'post') || tennis[0], ['tournament', 'grouping', 'round', 'homeTeam', 'homeLinescores', 'awayTeam', 'awayLinescores', 'winnerId', 'statusDetail', 'court']));
    if (mma[0]) console.log('  sample fight:', sample(mma[0], ['name', 'competitionType', 'homeTeam', 'awayTeam', 'winnerId', 'statusDetail', 'period', 'clock']));
}
// 4. A week-long span with a team filter: one request per day, deduped, only the wanted teams.
{
    const { code, rows, summary } = await runActor('scoreboard-span-nhl', { mode: 'scoreboard', leagues: ['nhl'], dates: `${weekAgo}..${yesterday}`, teams: ['BOS', 'TOR'], statusFilter: ['post'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 2, `Bruins and Leafs games in the last week, got ${rows.length}`);
    assert(rows.every((r) => ['BOS', 'TOR'].includes(r.homeAbbr) || ['BOS', 'TOR'].includes(r.awayAbbr)), 'team filter applied');
    assert(rows.every((r) => r.status === 'post' && r.dateLocal.slice(0, 10) >= weekAgo && r.dateLocal.slice(0, 10) <= yesterday), 'status filter and span respected');
    assert(summary.stats.requests === 7, `one request per day (${summary.stats.requests})`);
    assert(new Set(rows.map((r) => r.competitionId)).size === rows.length, 'no duplicate rows');
    console.log('  rows:', rows.map((r) => `${r.dateLocal.slice(0, 10)} ${r.shortName} ${r.awayScore}-${r.homeScore}`).join(' | '));
}
// 5. Team schedules: whole season per team, with the team's side and the season fields.
{
    const { code, rows } = await runActor('schedule-teams', { mode: 'schedule', leagues: ['nba', 'nfl', 'epl'], teams: ['nba/LAL', 'nfl/KC', 'epl/Arsenal'] });
    assert(code === 0, 'exit code 0');
    const lal = rows.filter((r) => r.scheduleTeamAbbr === 'LAL');
    const kc = rows.filter((r) => r.scheduleTeamAbbr === 'KC');
    const ars = rows.filter((r) => r.league === 'eng.1');
    assert(lal.length >= 80, `Lakers season schedule, got ${lal.length}`);
    assert(kc.length >= 16, `Chiefs season schedule, got ${kc.length}`);
    assert(ars.length >= 1, `Arsenal schedule resolved from the team name, got ${ars.length}`);
    assert(rows.every((r) => r.scheduleTeamId && ['home', 'away'].includes(r.scheduleHomeAway) && typeof r.seasonYear === 'number' && r.date), 'schedule fields');
    assert(lal.filter((r) => r.status === 'post').every((r) => typeof r.homeScore === 'number'), 'played games have scores');
    console.log('  sample:', sample(kc[0], ['shortName', 'dateLocal', 'week', 'status', 'scheduleHomeAway', 'homeAbbr', 'homeScore', 'awayAbbr', 'awayScore', 'broadcasts']));
}
// 6. Standings: divisions nested under conferences, soccer table with points, F1 drivers and constructors.
{
    const { code, rows } = await runActor('standings', { mode: 'standings', leagues: ['nfl', 'epl', 'f1', 'ncaaf'] });
    assert(code === 0, 'exit code 0');
    const nfl = rows.filter((r) => r.league === 'nfl');
    const epl = rows.filter((r) => r.league === 'eng.1');
    const f1 = rows.filter((r) => r.league === 'f1');
    const cfb = rows.filter((r) => r.league === 'college-football');
    assert(nfl.length === 32 && new Set(nfl.map((r) => r.group)).size === 8 && nfl.every((r) => r.conference && typeof r.wins === 'number' && typeof r.losses === 'number' && typeof r.winPercent === 'number' && r.overallRecord), `NFL 32 teams in 8 divisions with records (${nfl.length})`);
    assert(epl.length === 20 && epl.every((r) => typeof r.points === 'number' && typeof r.gamesPlayed === 'number' && typeof r.rank === 'number') && epl[0].rank === 1, `Premier League table (${epl.length})`);
    assert(f1.length >= 30 && f1.some((r) => r.athlete && r.group === 'Driver Standings' && typeof r.points === 'number') && f1.some((r) => r.team && r.group === 'Constructor Standings'), 'F1 drivers and constructors');
    assert(cfb.length >= 100 && cfb.every((r) => r.group), `FBS conferences (${cfb.length})`);
    assert(rows.every((r) => r.recordType === 'standing' && r.stats && typeof r.stats === 'object'), 'stat map present');
    console.log('  sample:', sample(nfl[0], ['conference', 'group', 'rank', 'team', 'wins', 'losses', 'ties', 'winPercent', 'pointDifferential', 'streak', 'playoffSeed', 'homeRecord', 'awayRecord']));
    console.log('  sample soccer:', sample(epl[0], ['group', 'rank', 'team', 'gamesPlayed', 'wins', 'ties', 'losses', 'points', 'pointDifferential', 'note']));
}
// 7. Game summaries for team sports, with play-by-play on: box scores, leaders, odds, win probability, plays, drives, lineups.
{
    const ids = [discovered.nba && `nba/${discovered.nba}`, discovered.nhl && `nhl/${discovered.nhl}`, discovered.epl && `epl/${discovered.epl}`, 'mlb/401907994', 'ncaaf/401860901'].filter(Boolean);
    const { code, rows } = await runActor('game-team-sports', { mode: 'game', leagues: ['nba', 'nhl', 'epl', 'mlb', 'ncaaf'], eventIds: ids, includePlayByPlay: true, maxPlays: 100 });
    assert(code === 0, 'exit code 0');
    assert(rows.length === ids.length, `one summary per id (${rows.length}/${ids.length})`);
    for (const r of rows) {
        assert(r.recordType === 'gameSummary' && r.homeTeamId && r.awayTeamId && r.venueName && Array.isArray(r.officials) && r.teamStats?.home && Object.keys(r.teamStats.home).length >= 4, `summary header and team stats on ${r.league} ${r.eventId}`);
        if (r.sport !== 'soccer') assert(Array.isArray(r.players) && r.players.length >= 20 && r.players[0].athleteId && Object.keys(r.players[0].stats).length >= 5, `player box score on ${r.league} ${r.eventId} (${r.players?.length})`);
        else assert(Array.isArray(r.lineups) && r.lineups.length === 2 && r.lineups[0].players.length >= 11 && r.lineups[0].formation && Array.isArray(r.keyEvents) && r.keyEvents.length > 5, `soccer lineups and key events on ${r.eventId}`);
        assert(r.odds === null || (r.odds.provider && typeof r.odds.homeSpread === 'number'), `odds normalized on ${r.eventId}`);
        if (r.sport === 'basketball' || r.sport === 'football') assert(r.winProbability && typeof r.winProbability.homeWinPercentage === 'number' && r.winProbability.points > 50 && Array.isArray(r.winProbabilityTimeline), `win probability on ${r.league} ${r.eventId}`);
        if (r.sport !== 'soccer' && r.sport !== 'football') assert(Array.isArray(r.plays) && r.plays.length === 100 && r.playCount > 100 && r.plays[10].text && typeof r.plays[10].period === 'number', `plays capped at maxPlays on ${r.league} ${r.eventId} (${r.plays?.length}/${r.playCount})`);
        if (r.sport === 'football') assert(Array.isArray(r.drives) && r.drives.length >= 5 && r.drives[0].teamId && typeof r.drives[0].yards === 'number' && r.scoringPlays.length >= 1, `drives and scoring plays on ${r.eventId}`);
    }
    const nba = rows.find((r) => r.league === 'nba');
    if (nba) console.log('  sample nba:', sample(nba, ['name', 'statusDetail', 'homeScore', 'awayScore', 'attendance', 'venueName', 'winProbability', 'playCount']), 'player:', JSON.stringify(nba.players[0]), 'play:', JSON.stringify(nba.plays[20]));
    const epl = rows.find((r) => r.league === 'eng.1');
    if (epl) console.log('  sample soccer lineup:', JSON.stringify(epl.lineups[0].players[0]), 'goal:', JSON.stringify(epl.keyEvents.find((k) => k.scoringPlay) || epl.keyEvents[0]));
}
// 8. Game summaries for athlete sports: UFC card, golf leaderboard, tennis tournament, F1 weekend, a cricket match.
{
    const { code, rows } = await runActor('game-athlete-sports', { mode: 'game', leagues: ['ufc', 'pga', 'atp', 'f1', 'cricket/8048'], eventIds: ['ufc/600061541', 'pga/401850916', 'atp/959-2026', 'f1/600057445', 'cricket/8048/1535465'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 5, `five summaries, got ${rows.length}`);
    const ufc = rows.find((r) => r.sport === 'mma');
    const golf = rows.find((r) => r.sport === 'golf');
    const atp = rows.find((r) => r.sport === 'tennis');
    const f1 = rows.find((r) => r.sport === 'racing');
    const cricket = rows.find((r) => r.sport === 'cricket');
    assert(ufc && ufc.fightCount >= 10 && ufc.fights[0].competitors.length === 2 && ufc.fights[0].weightClass && ufc.fights.some((f) => f.resultMethod) && ufc.mainEvent, 'UFC card with fights and results');
    assert(golf && golf.leaderboard.length >= 60 && golf.leaderboard[0].athlete && golf.leaderboard[0].rounds.length >= 1 && golf.course?.name && typeof golf.purse === 'number', 'golf leaderboard with rounds, course and purse');
    assert(atp && atp.competitionCount >= 100 && atp.competitions[0].round && atp.competitions[0].competitors?.length === 2, 'tennis tournament with every match');
    assert(f1 && f1.competitionCount === 5 && f1.competitions.map((c) => c.competitionType).includes('Race') && f1.circuit?.name, 'F1 weekend sessions and circuit');
    assert(cricket && cricket.innings?.length >= 2 && cricket.innings[0].players.length >= 5 && cricket.homeScoreText && cricket.statusDetail, 'cricket scorecard innings');
    console.log('  ufc fight:', JSON.stringify({ ...ufc.fights[0], competitors: ufc.fights[0].competitors.map((c) => ({ name: c.name, record: c.record, winner: c.winner })) }));
    console.log('  golf leader:', JSON.stringify(golf.leaderboard[0]).slice(0, 400));
    console.log('  f1 sessions:', JSON.stringify(f1.competitions.map((c) => `${c.competitionType}:${c.status}:${(c.competitors || []).slice(0, 3).map((x) => x.name).join(',')}`)));
}
// 9. Teams directory and rosters, including a soccer team resolved by abbreviation.
{
    const { code, rows } = await runActor('teams', { mode: 'teams', leagues: ['nba', 'mlb'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length === 60 && rows.every((r) => r.recordType === 'team' && r.teamId && r.abbreviation && r.displayName && r.logo && r.url), `60 teams with ids, abbreviations and logos (${rows.length})`);
    console.log('  sample:', sample(rows[0], ['league', 'teamId', 'abbreviation', 'displayName', 'location', 'color', 'url']));
    const r2 = await runActor('roster', { mode: 'roster', leagues: ['nfl', 'epl'], teams: ['nfl/KC', 'epl/ARS'] });
    assert(r2.code === 0, 'exit code 0');
    const kc = r2.rows.filter((r) => r.teamAbbr === 'KC');
    const ars = r2.rows.filter((r) => r.league === 'eng.1');
    assert(kc.length >= 50 && kc.every((r) => r.athleteId && r.fullName && r.positionAbbr && r.positionGroup) && kc[0].headCoach, `Chiefs roster grouped by unit (${kc.length})`);
    assert(ars.length >= 20 && ars.every((r) => r.athleteId && r.fullName && r.position), `Arsenal roster via abbreviation lookup (${ars.length})`);
    console.log('  sample:', sample(kc[0], ['team', 'headCoach', 'fullName', 'jersey', 'positionAbbr', 'positionGroup', 'age', 'displayHeight', 'displayWeight', 'college', 'experienceYears', 'status']));
}
// 10. Injuries for two leagues.
{
    const { code, rows } = await runActor('injuries', { mode: 'injuries', leagues: ['nfl', 'nba'] });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 50, `injury reports, got ${rows.length}`);
    assert(rows.every((r) => r.recordType === 'injury' && r.teamId && r.athlete && r.status), 'injury fields');
    assert(rows.some((r) => r.injuryType && r.returnDate) && rows.some((r) => r.shortComment), 'injury details and comments');
    console.log('  sample:', sample(rows.find((r) => r.returnDate) || rows[0], ['league', 'team', 'athlete', 'position', 'status', 'statusType', 'injuryType', 'detail', 'returnDate', 'shortComment']));
}
// 11. News for two leagues, capped by maxResults, and team-scoped news.
{
    const { code, rows, summary } = await runActor('news', { mode: 'news', leagues: ['nfl', 'atp'], maxResults: 40 });
    assert(code === 0, 'exit code 0');
    assert(rows.length >= 10 && rows.length <= 40, `articles capped at 40, got ${rows.length}`);
    assert(rows.every((r) => r.recordType === 'article' && r.articleId && r.headline && r.url && r.published), 'article fields');
    assert(rows.some((r) => r.teams.length > 0 || r.athletes.length > 0), 'tagged teams or athletes');
    console.log('  sample:', sample(rows[0], ['league', 'type', 'headline', 'byline', 'published', 'url', 'teams']), summary.stopReason);
    const r2 = await runActor('news-team', { mode: 'news', leagues: ['nba'], teams: ['13'], maxResults: 10 });
    assert(r2.code === 0 && r2.rows.length >= 1 && r2.rows.every((r) => r.teamFilter === '13'), `team news (${r2.rows.length})`);
}
// 12. Odds: featured line per event from the scoreboard, then every sportsbook from the odds feed.
{
    const { code, rows } = await runActor('odds-featured', { mode: 'odds', leagues: ['nfl', 'nba', 'epl'], dates: 'today' });
    assert(code === 0, 'exit code 0');
    for (const r of rows) assert(r.recordType === 'odds' && r.eventId && r.provider && r.source === 'scoreboard' && typeof r.homeSpread === 'number' && typeof r.overUnder === 'number' && (typeof r.homeMoneyline === 'number' || typeof r.awayMoneyline === 'number'), `odds row ${r.shortName}: ${JSON.stringify(r)}`);
    assert(rows.filter((r) => r.league === 'eng.1').every((r) => typeof r.drawMoneyline === 'number'), 'soccer rows carry the draw line');
    assert(new Set(rows.map((r) => `${r.competitionId}:${r.providerId}`)).size === rows.length, 'no duplicate lines');
    if (rows[0]) console.log('  sample:', sample(rows[0], ['league', 'shortName', 'status', 'provider', 'details', 'favorite', 'homeSpread', 'homeSpreadOdds', 'overUnder', 'overOdds', 'homeMoneyline', 'awayMoneyline', 'drawMoneyline', 'open']));
    const r2 = await runActor('odds-all-books', { mode: 'odds', leagues: ['epl'], dates: 'today', allOddsProviders: true });
    assert(r2.code === 0, 'exit code 0');
    if (r2.rows.length) assert(r2.rows.every((r) => r.source === 'odds-feed') && new Set(r2.rows.map((r) => r.provider)).size >= 2, `several sportsbooks from the odds feed (${[...new Set(r2.rows.map((r) => r.provider))].join(', ')})`);
    if (rows.length === 0 && r2.rows.length === 0) console.log('  no games with lines today for nfl/nba/epl (off day); structure checks skipped');
}
// 13. Rankings: college polls, ATP and UFC.
{
    const { code, rows } = await runActor('rankings', { mode: 'rankings', leagues: ['ncaaf', 'atp', 'ufc'] });
    assert(code === 0, 'exit code 0');
    const polls = rows.filter((r) => r.league === 'college-football');
    const atp = rows.filter((r) => r.league === 'atp');
    const ufc = rows.filter((r) => r.league === 'ufc');
    assert(new Set(polls.map((r) => r.poll)).size >= 2 && polls.filter((r) => r.poll === 'AP Top 25' && r.section === 'ranked').length === 25 && polls.every((r) => r.team && typeof r.rank === 'number'), 'college polls with 25 ranked teams');
    assert(atp.length >= 100 && atp[0].rank === 1 && atp.every((r) => r.athlete && typeof r.points === 'number'), `ATP rankings (${atp.length})`);
    assert(ufc.length >= 50 && new Set(ufc.map((r) => r.poll)).size >= 10 && ufc.every((r) => r.athlete), `UFC divisional rankings (${ufc.length})`);
    console.log('  sample:', sample(polls[0], ['poll', 'week', 'rank', 'previous', 'trend', 'points', 'firstPlaceVotes', 'team', 'teamAbbr', 'recordSummary']), sample(atp[0], ['poll', 'rank', 'athlete', 'athleteCountry', 'points']));
}
// 14. Bad input fails clearly with exit code 91 and no rows.
{
    const cases = [
        ['unknown-league', { mode: 'scoreboard', leagues: ['nope'] }],
        ['bad-date', { mode: 'scoreboard', leagues: ['nba'], dates: '2026-13-45' }],
        ['roster-without-teams', { mode: 'roster', leagues: ['nba'] }],
        ['ambiguous-event-id', { mode: 'game', leagues: ['nba', 'nfl'], eventIds: ['401902645'] }],
        ['bad-timezone', { mode: 'scoreboard', leagues: ['nba'], timezone: 'Mars/Olympus' }],
    ];
    for (const [name, input] of cases) {
        const { code, rows } = await runActor(`invalid-${name}`, input);
        assert(code === 91 && rows.length === 0, `${name} exits 91 without rows (exit ${code}, ${rows.length} rows)`);
    }
    const r = await runActor('unknown-league-code-on-espn', { mode: 'scoreboard', leagues: ['soccer/zzz.9'], dates: 'yesterday' });
    assert(r.code !== 0 && r.rows.length === 0 && r.summary?.failures?.length === 1, 'a league ESPN does not know fails with a recorded reason');
}

console.log('\nRESULTS');
console.table(results);
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
