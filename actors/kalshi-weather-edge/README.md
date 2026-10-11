# Kalshi Weather Edge

Every open Kalshi daily temperature and rain bracket market, joined to the public forecasts for the station the market actually settles on. One row per market with the bracket bounds, close time, bid/ask/mid and order-book depth from Kalshi's public API, the NWS and Open-Meteo forecast high/low/precipitation probability for the target date, a simple normal-model probability for the bracket, and the difference between that probability and the market mid.

**This is descriptive data, not advice.** The model is a normal distribution around a public forecast with an assumed, published standard deviation per city. It knows nothing the forecast does not know; a large "edge" says the market disagrees with the forecast, which is often because the market knows more. The operator of this Actor does not trade these markets.

## What you can do with it

- **Research datasets** - snapshot all 600+ open weather markets a few times a day and build a history of market price versus forecast versus settlement.
- **Dashboards and alerts** - feed the dataset into a sheet or a bot that shows where the public forecast and the market diverge by more than a threshold.
- **Model development** - the raw NWS and Open-Meteo values, the station, the bracket bounds and the book are all in the row; swap in your own probability model and keep the plumbing.
- **Teaching material** - a clean example of bracket markets, implied probabilities and forecast uncertainty.

## How it works

1. Series discovery from Kalshi's public market-data API (`/series?category=Climate and Weather`), keeping `KXHIGH*`, `KXLOW*` and `KXRAIN*` daily series (about 110 series, US and international cities).
2. Open markets per series, paged, with the settlement station parsed from the market rules (`New York City (CLINYC)` and so on) or from the ICAO code in the series ticker (`KXHIGHTEGLL` = London Heathrow). 85 stations are mapped with coordinates and time zone.
3. One forecast fetch per station: NWS gridpoint data (`api.weather.gov`, US only; daily max/min, precipitation probability, QPF) and Open-Meteo (`api.open-meteo.com`, all stations). Values are matched to the market's local calendar day.
4. Optional order book per market (best bid/ask with sizes, total depth per side); the mid comes from the book when present.
5. Scoring. For a temperature market the forecast mean is the average of the available sources, the settlement is a whole degree, and the bracket `[lo, hi]` is scored as `P(lo - 0.5 < X < hi + 0.5)` with `X ~ Normal(mean, sigma)`. `sigma = base(city) x sigmaScale x (1 + leadTimeGrowth x (leadDays - 1))`; the base is 2.0-4.0 F per station (3.0 F for New York, 3.5 F for Chicago, 4.0 F for Denver, 2.3 F for Miami; the full table is in `src/stations.js`) and is an assumption, not a measurement. For a daily rain market ("more than 0 inches") the probability is the average precipitation probability of the sources.
6. Same-day markets are scored only before `sameDayCutoffHour` (noon by default) at the station; later the day is mostly observed, so the row is kept with the station's observed high, low and precipitation so far (NWS observations since local midnight) and no model probability.

## Input

| Field | Meaning |
|---|---|
| `seriesTickers` | e.g. `["KXHIGHNY", "KXLOWTCHI", "KXRAIN"]`; `KXHIGH*` selects by prefix; empty = all daily temperature and rain series. |
| `marketTypes` | `high`, `low`, `rain`. |
| `cities` | Filter by city name, NWS climate code (`CLIMDW`) or ICAO (`KMDW`). |
| `maxDaysAhead` | Markets further out are listed but not scored (default 7). |
| `maxMarkets` | Cap (default 500, up to 5,000); only scored markets are charged. |
| `includeOrderbook`, `orderbookDepth` | One extra request per market for book depth (on by default). |
| `forecastSources` | `nws`, `open-meteo` (both by default; the model averages what is available). |
| `sigmaScale`, `leadTimeGrowth`, `sigmaOverrides` | Model assumptions, see above. |
| `sameDayCutoffHour`, `includeObservations` | Same-day handling, see above. |
| `minVolume`, `includeUnscored` | Filters. |

```json
{ "seriesTickers": ["KXHIGHNY", "KXLOWTNYC", "KXRAIN"], "maxMarkets": 200 }
```

## Output

One row per market (abridged):

```json
{
  "ticker": "KXHIGHNY-26OCT11-B62.5",
  "eventTicker": "KXHIGHNY-26OCT11",
  "seriesTicker": "KXHIGHNY",
  "kind": "high",
  "title": "Will the maximum temperature be 62-63° on Oct 11, 2026?",
  "bracketLabel": "62° to 63°",
  "city": "New York City",
  "stationCode": "CLINYC",
  "station": "KNYC",
  "lat": 40.7789,
  "lon": -73.9692,
  "timezone": "America/New_York",
  "targetDate": "2026-10-11",
  "leadDays": 1,
  "unit": "F",
  "strikeType": "between",
  "floorStrike": 62,
  "capStrike": 63,
  "bracketLow": 62,
  "bracketHigh": 63,
  "closeTime": "2026-10-12T05:00:00Z",
  "yesBid": 0.3,
  "yesAsk": 0.31,
  "yesMid": 0.305,
  "spread": 0.01,
  "lastPrice": 0.31,
  "volume": 1946.38,
  "openInterest": 1655.45,
  "bookYesBid": 0.3,
  "bookYesAsk": 0.31,
  "bookYesBidSize": 136.63,
  "bookYesAskSize": 115.4,
  "bookYesDepth": 752.79,
  "bookNoDepth": 384.4,
  "nwsHigh": 63,
  "nwsLow": 55,
  "nwsPop": 100,
  "nwsPrecipIn": 1.1,
  "nwsOffice": "OKX",
  "openMeteoHigh": 65.4,
  "openMeteoLow": 54.2,
  "openMeteoPop": 91,
  "openMeteoPrecipIn": 0.77,
  "observedHighSoFar": null,
  "observedLowSoFar": null,
  "localHourAtStation": 21,
  "forecastValue": 64.2,
  "forecastSourcesUsed": ["nws", "open-meteo"],
  "sigma": 3,
  "modelProbability": 0.2692,
  "edge": -0.0358,
  "absEdge": 0.0358,
  "scored": true,
  "notes": [],
  "settlementSource": "The Weather Company",
  "rulesPrimary": "If the maximum temperature recorded at New York City (CLINYC) for Oct 11, 2026, is between 62-63° fahrenheit ...",
  "fetchedAt": "2026-10-11T01:02:33.731Z"
}
```

Bracket semantics follow the rules text: `greater than 69` is `bracketLow: 70`, `less than 62` is `bracketHigh: 61`, `between 68-69` is inclusive. The six brackets of one event get model probabilities that sum to one. `edge = modelProbability - yesMid`; the sign says which way the forecast leans relative to the market, nothing more.

The key-value store record `SUMMARY` holds the run statistics, the assumptions used, the station list with forecast status, any forecast or observation fetch errors, the unscored reasons with counts, and the ten largest absolute edges.

## Pricing

Pay per event:

| Event | Price |
|---|---|
| Run start | $0.005 |
| Market scored | $0.004 |

Examples: the New York high and low series plus the national daily rain series (about 45 scorable markets) cost $0.005 + 45 x $0.004 = **$0.19**; every open daily temperature and rain market (around 300 scorable at any time) costs about $1.20. Markets that cannot be scored (same-day after the cutoff, unknown station, rain amount thresholds) are included free with a note.

## Limits

- Kalshi lists most weather markets one to two days ahead, so most rows have `leadDays` 0 or 1; `maxDaysAhead` rarely matters.
- NWS covers US stations only; international markets (London, Paris, Tokyo ...) are scored from Open-Meteo alone and their units follow the rules text (Celsius where stated).
- Only "rain yes/no" markets (threshold 0) are modelled. Weekly and monthly rainfall totals and amount thresholds are listed unscored.
- The sigma table is a stated assumption. Verification against settlements is yours to do; the dataset gives you everything needed for it.
- Public rate limits: Kalshi requests run five per second at most, NWS and Open-Meteo about three per second, with retries on 429 and 5xx. A full scan of all series with order books takes two to four minutes.
- The Actor reads public endpoints without authentication and never places orders.

## Local test

`npm test` runs the Actor against the live APIs: New York high/low plus the multi-city rain series with order books (checks station mapping, bracket semantics, both forecast sources, probability sums per event, same-day handling with observations), a prefix scan of all daily-high series filtered to Chicago and Denver with a scaled sigma, and three invalid inputs that must fail without rows.
