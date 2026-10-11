# ESPN Sports Data

Scores, schedules, standings, full game summaries, rosters, injuries, news, rankings and sportsbook lines from the public JSON endpoints behind espn.com, for every league ESPN carries: NFL, NBA, WNBA, MLB, NHL, college football and basketball, more than 200 soccer competitions, ATP and WTA tennis, PGA and LPGA golf, UFC, Formula 1, NASCAR and cricket series. No ESPN key, no login, no browser. Every row has the same keys across leagues (`league`, `eventId`, `date` in UTC, `dateLocal`, `status`, home and away ids, names, scores, line scores, venue, broadcasts, odds, source URL), so one pipeline handles all sports.

## What you can do with it

- **Live and historical scoreboards** - one request per league and day; scores, period and clock, line scores, team records, game leaders, the featured sportsbook line, venue and TV.
- **Odds feeds** - spread, total, moneylines and the soccer draw line, with opening values; optionally every sportsbook ESPN lists per game.
- **Game archives** - team and player box scores, leaders, scoring plays, full play-by-play, drives, soccer lineups and key events, officials, attendance, win probability, closing lines.
- **Reference tables** - team directories with ids, abbreviations and logos; rosters with age, size, college and injury status; standings by conference and division; AP, Coaches, ATP, WTA and UFC rankings.
- **Content feeds** - headlines per league or team with byline, image, tagged teams and athletes.

## Modes

| Mode | Input it uses | One row per |
|---|---|---|
| `scoreboard` | `leagues`, `dates`, `statusFilter`, `teams` (filter) | game, tennis match, fight, race session; one row per golf tournament |
| `schedule` | `leagues`, `teams` (season schedule of each team), `season`, `seasonType`; without teams: `dates` | game |
| `standings` | `leagues`, `season`, `seasonType`, `groups` | team (or F1 driver and constructor) |
| `game` | `eventIds`, `includeBoxScore`, `includePlayByPlay`, `maxPlays` | event: full summary |
| `teams` | `leagues`, `groups`, `includeTeamDetails` | team |
| `roster` | `leagues`, `teams` | player |
| `injuries` | `leagues`, `teams` (filter) | injury report |
| `news` | `leagues`, `teams` (team feed) | article |
| `odds` | `leagues`, `dates`, `statusFilter`, `allOddsProviders` | event x sportsbook |
| `rankings` | `leagues`, `season` | poll entry |

## League codes

Short codes: `nfl`, `nba`, `wnba`, `mlb`, `nhl`, `ncaaf`, `ncaam`, `ncaaw`, `epl`, `championship`, `fa-cup`, `laliga`, `bundesliga`, `seriea`, `ligue1`, `eredivisie`, `primeira-liga`, `liga-mx`, `mls`, `nwsl`, `ucl`, `uel`, `uecl`, `world-cup`, `euros`, `copa-america`, `libertadores`, `soccer-all` (every soccer match ESPN lists that day), `atp`, `wta`, `pga`, `lpga`, `dp-world`, `liv`, `ufc`, `pfl`, `f1`, `nascar`, `indycar`, `ipl`.

Anything else is passed through as ESPN writes it, `sport/league`: `soccer/ned.1`, `soccer/bra.1`, `soccer/arg.1`, `soccer/uefa.nations`, `golf/eur`, `racing/nascar-premier`, `mma/bellator`, `cricket/8048`. A bare code with a dot (`ger.2`) is taken as soccer, a bare number as a cricket series id. The league slug appears in the ESPN URL of any scoreboard page.

## Input

| Field | Meaning |
|---|---|
| `mode` | One of the modes above. Default `scoreboard`. |
| `leagues` | List of codes. Required. |
| `dates` | `today` (default), `yesterday`, `tomorrow`, `2026-10-11`, `20261011`, a span `2026-10-01..2026-10-07` (up to 366 days; spans of up to 45 days are fetched one day at a time, longer spans month by month), a month `202610` or a year `2026`. |
| `timezone` | IANA zone for resolving `today` and for `dateLocal`. Default `America/New_York`, which matches ESPN's own game days. |
| `teams` | ESPN team ids, abbreviations or names (`LAL`, `KC`, `ARS`, `13`, `Arsenal`), optionally scoped `nba/LAL`. Required by `roster`; selects season schedules in `schedule`; filters `scoreboard`, `odds` and `injuries`; picks the team feed in `news`. |
| `eventIds` | For `game`: `nba/401902645`, `ufc/600061541`, `pga/401850916`, `atp/959-2026`, `cricket/8048/1535465`, a bare id when one league is given, or an ESPN gamecast URL. |
| `season`, `seasonType` | Season year (ESPN convention: the 2025-26 NBA season is `2026`) and 1 pre, 2 regular, 3 post. Empty = the current season; a team schedule fetched during a preseason also includes that season's regular-season games. |
| `groups` | College group or conference id: 80 FBS (default for college football), 81 FCS, 50 Division I (default for college basketball), or a conference id. |
| `statusFilter` | Any of `pre`, `in`, `post`. `["in"]` is a live feed, `["pre"]` upcoming games with lines. |
| `includeBoxScore`, `includePlayByPlay`, `maxPlays` | Game mode detail. Play-by-play adds every play (450-550 for a basketball game), drives for football and commentary for soccer, capped at `maxPlays`. |
| `allOddsProviders` | Odds mode: one extra request per event for every sportsbook with open, close and current values. |
| `includeTeamDetails` | Teams mode: one extra request per team for venue, record, standing summary and next event. |
| `maxResults` | Row cap for the run (default 1000, up to 20000). |

```json
{ "mode": "scoreboard", "leagues": ["nba", "nhl", "epl"], "dates": "yesterday" }
```

```json
{ "mode": "game", "leagues": ["nba"], "eventIds": ["401902645"], "includePlayByPlay": true }
```

```json
{ "mode": "odds", "leagues": ["nfl", "ucl"], "dates": "today", "statusFilter": ["pre"], "allOddsProviders": true }
```

## Output

Scoreboard and schedule row (abridged):

```json
{
  "recordType": "event",
  "sport": "hockey",
  "league": "nhl",
  "leagueName": "National Hockey League",
  "eventId": "401892469",
  "competitionId": "401892469",
  "name": "Philadelphia Flyers at Boston Bruins",
  "shortName": "PHI @ BOS",
  "date": "2026-10-10T17:00:00.000Z",
  "dateLocal": "2026-10-10 13:00",
  "timezone": "America/New_York",
  "seasonYear": 2027,
  "seasonType": 2,
  "status": "post",
  "statusDetail": "Final",
  "completed": true,
  "period": 3,
  "clock": "1:16",
  "homeTeamId": "1",
  "homeTeam": "Boston Bruins",
  "homeAbbr": "BOS",
  "homeScore": 5,
  "homeWinner": true,
  "homeRecord": "4-2-0",
  "homeLinescores": [1, 2, 2],
  "awayTeamId": "4",
  "awayTeam": "Philadelphia Flyers",
  "awayAbbr": "PHI",
  "awayScore": 1,
  "awayWinner": false,
  "awayRecord": "2-2-1",
  "awayLinescores": [0, 1, 0],
  "winnerId": "1",
  "attendance": 17850,
  "venue": { "id": "1824", "name": "TD Garden", "city": "Boston", "state": "MA", "country": "USA", "indoor": true },
  "broadcasts": ["NHL Net", "NBC Sports Phil", "NESN"],
  "odds": null,
  "leaders": [{ "category": "goals", "teamAbbr": "BOS", "athleteId": "3114778", "athlete": "David Pastrnak", "value": 2, "displayValue": "2" }],
  "url": "https://www.espn.com/nhl/game/_/gameId/401892469/flyers-bruins",
  "fetchedAt": "2026-10-11T05:10:02.114Z"
}
```

Upcoming games carry `odds` with the featured line: `provider`, `details` ("JAX -7.5"), `favorite`, `homeSpread`, `awaySpread`, `homeSpreadOdds`, `awaySpreadOdds`, `overUnder`, `overOdds`, `underOdds`, `homeMoneyline`, `awayMoneyline`, `drawMoneyline` (soccer) and `open` with the opening spread, total and moneylines. `homeSpread` is the home team's line, negative when the home side is favored. Live games add `situation` (possession, down and distance, last play; balls, strikes, outs and runners for baseball). Tennis rows add `tournament`, `grouping` (Men's Singles, Women's Doubles), `round` and `court`, with set scores in `homeLinescores`/`awayLinescores`; doubles pairs are named "A / B" with both players in `competitors[].athletes`; UFC rows put the weight class in `competitionType`; F1 rows have one row per session (FP1, Qualifying, Race) with the field in `competitors`; golf rows are one per tournament with the leaderboard in `competitors`.

Odds row: the event header plus one sportsbook's line, `source` (`scoreboard` for the featured line, `odds-feed` with `allOddsProviders`), and after the game `moneylineWinner` and `spreadWinner`.

Standings row: `conference`, `group` (division or table), `rank`, `team`, `wins`, `losses`, `ties`, `otLosses`, `winPercent`, `points`, `gamesPlayed`, `gamesBehind`, `pointsFor`, `pointsAgainst`, `pointDifferential`, `streak`, `playoffSeed`, `clincher`, `overallRecord`, `homeRecord`, `awayRecord`, `divisionRecord`, `conferenceRecord`, `note` (soccer qualification notes) and `stats` with every column ESPN shows for that league.

Game summary row: the event header, `teamStats` (home and away, every team statistic by name), `players` (one entry per player and stat group, `stats` keyed by ESPN's stat keys: `points`, `rebounds`, `hits`, `earnedRuns`, `passingYards` ...), `lineups` with formation and substitutions for soccer, `leaders`, `scoringPlays`, `keyEvents` (soccer), `plays` and `drives` or `commentary` with `includePlayByPlay`, `odds` and `oddsLines` (closing lines with open values), `winProbability` (final or current home win probability and the number of points in the series), `injuries`, `officials`, `weather`, `seasonSeries`, `attendance`. UFC event ids return the whole card as `fights` with weight class, result method, round and time, fighter records, reach, stance and strike counts; golf ids return `leaderboard` with position, to-par, strokes, per-round scores, tee time, earnings, plus course, purse and defending champion; tennis and F1 ids return every match or session of the event in `competitions`; cricket ids return `innings` scorecards.

Roster row: `fullName`, `jersey`, `position`, `positionGroup` (offense, defense, special teams for football), `age`, `dateOfBirth`, `displayHeight`, `displayWeight`, birthplace, `college`, `experienceYears`, `status`, `injuryStatus`, `headshot`, `headCoach`. Injury row: `athlete`, `position`, `status`, `statusType`, `injuryType`, `location`, `detail`, `side`, `returnDate`, `fantasyStatus`, `shortComment`, `longComment`. Article row: `headline`, `description`, `byline`, `published`, `url`, `image`, `teams`, `athletes`, `leagues`. Ranking row: `poll`, `week`, `rank`, `previous`, `trend`, `points`, `firstPlaceVotes`, `team` or `athlete`, `recordSummary`, `section` (`ranked`, `others`, `droppedOut`).

The key-value store record `SUMMARY` holds the run statistics (requests, retries, rows per league and type, rows deduplicated or filtered) and every per-league, per-team or per-event failure with its reason.

## Pricing

Pay per event:

| Event | Price |
|---|---|
| Run start | $0.005 |
| Event, team, player or injury row | $0.002 |
| Game summary | $0.01 |
| Standings or ranking row | $0.0005 |
| News article | $0.001 |
| Odds row | $0.003 |

Examples: yesterday's NBA and NHL scoreboard (about 20 games) costs $0.005 + 20 x $0.002 = **$0.045**; a full NFL Sunday with lines for every game, 14 odds rows, costs **$0.047**; NFL standings, 32 rows, costs **$0.021**; ten complete game summaries with play-by-play cost **$0.105**; a 30-team roster pull of the NBA (about 540 players) costs **$1.09**. Rows that are deduplicated or filtered out by status, team or date span are not charged.

## Limits

- Requests run at two per second across all ESPN hosts, with retries and backoff on 429 and 5xx responses. A single scoreboard day for one league is one request; `allOddsProviders` and `includeTeamDetails` add one request per event or team.
- ESPN's scoreboard does not accept date ranges, so spans are fetched one day at a time (up to 45 days) or one month at a time, then filtered. Month and year tokens are single requests but return large payloads for golf and tennis (20 MB and more for a year); prefer short spans there.
- Tennis tournaments, race weekends and fight cards are returned whole by ESPN on every day they cover. For day spans the Actor keeps only the matches, sessions and fights of the requested days; golf stays one tournament row with the full field.
- The featured line comes from the sportsbook ESPN currently integrates (DraftKings at the time of writing). The odds feed adds the other books ESPN lists (Bet365, live lines). Lines exist only for games that had a market, mostly US leagues and major soccer.
- Game summaries exist for team sports and cricket. Tennis and F1 have no summary endpoint on ESPN; their game rows are built from the event's scoreboard entry (all matches or sessions). Golf uses the leaderboard endpoint, UFC the fight-center endpoint.
- Injury reports are published for NFL, NBA, WNBA, MLB, NHL and some college football; other leagues return no rows. The teams and roster endpoints are empty for tennis, golf and UFC (athlete sports): use `rankings` for those.
- Cricket is addressed by numeric series id (`cricket/8048` is the Indian Premier League); the teams endpoint is not available for cricket, scoreboard, game and news are.
- College standings and scoreboards default to the top division (`groups` 80 for football, 50 for basketball); set `groups` for FCS or a conference. College basketball standings are large (about 360 teams in 31 conferences).
- Season years follow ESPN: the 2025-26 NBA and NHL seasons are `2026`, the 2026 NFL season is `2026`, the 2026-27 Premier League is `2026`.
- A league code ESPN does not know, a team not in the league or an event id that does not resolve is reported in `SUMMARY.failures` and logged; the run fails only when nothing at all could be fetched. Invalid input (unknown code format, bad date, missing `teams` for roster) fails immediately.
- The Actor reads public endpoints without authentication. It is not affiliated with ESPN, and ESPN can change or remove these endpoints without notice.

## Local test

`npm test` runs the Actor against the live endpoints: yesterday's NBA and NHL scoreboard, today's NFL and Premier League with lines, tennis, golf, UFC and F1 scoreboards, a week-long NHL span with a team filter, team schedules, standings for four leagues, game summaries for five team sports with play-by-play and for a UFC card, a golf leaderboard, a tennis tournament, an F1 weekend and a cricket match, team directories, rosters, injuries, news, odds from the scoreboard and from the odds feed, rankings, and six invalid inputs that must fail without rows.
