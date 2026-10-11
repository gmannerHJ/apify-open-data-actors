---
name: apify-open-data-actors
description: Get local business leads (Overture Maps), full sitemap URL lists with lastmod and status, Google Play app intelligence, French real-estate listings (Bien'ici), Shopify storefront tech stacks and contacts, and Kalshi weather-market odds versus forecasts plus Google News articles and Yahoo Finance quotes, history, fundamentals and options, and ESPN sports scores, schedules, standings and odds, and TradingView stock/crypto screens, through ten pay-per-result Apify Actors. Use when a task needs businesses in an area, all URLs of a website, app-store data, French property listings, Shopify store profiling or weather-market data, and the user has an Apify token (APIFY_TOKEN). Each run costs fractions of a cent per result; quote the price before running.
---

# Apify open-data Actors

Ten Actors on the Apify Store, each returning a clean dataset and charging per result. You need `APIFY_TOKEN` (free Apify account; the free plan includes $5 of monthly usage).

| Need | Actor id | Price (USD) |
|---|---|---|
| Businesses in a bounding box or radius, with phone / website flag / address | `gmanner~overture-local-leads` | 0.003 per run + 0.003 per lead |
| Every URL a site lists in its sitemaps, with lastmod, optional HTTP status | `gmanner~sitemap-extractor-plus` | 0.003 per run + 0.0004 per URL (+0.0003 per status check) |
| Google Play app details / search / top charts / developer portfolio | `gmanner~google-play-app-intel` | 0.005 per run + 0.002 per app (0.003 per search term) |
| French sale or rental listings by city, postcode or department, with price, surface, rooms, DPE class | `gmanner~bienici-fr-listings` | 0.005 per run + 0.0025 per listing |
| Shopify storefront profile: theme, installed apps, product counts, last update, role mailboxes | `gmanner~shopify-app-stack-leads` | 0.001 per run + 0.012 per analysed store (unreachable rows free) |
| Kalshi daily weather markets with order book, forecasts, model probability and edge | `gmanner~kalshi-weather-edge` | 0.005 per run + 0.004 per scored market (unscored rows free) |
| Google News articles by query/topic/feed URL with decoded publisher URLs, optional article text | `gmanner~google-news-feed` | 0.002 per run + 0.001 per article (+0.004 per article text) |
| Yahoo Finance quotes, history, fundamentals, options with Greeks, search, news | `gmanner~yahoo-finance-data` | 0.002 per run + 0.0005 per quote, 0.005 per 100 history bars, 0.002 per fundamentals module, 0.0003 per option row, 0.001 per news row |
| Sports scores, schedules, standings, box scores, rosters, injuries, news, rankings, betting lines (ESPN) | `gmanner~espn-sports-data` | 0.005 per run + 0.002 per event row, 0.01 per game summary, 0.0005 per standings row, 0.001 per news row, 0.003 per odds row |
| Stock/crypto/forex/futures screener across 77 markets, any column and filter, presets, ticker snapshots (TradingView scanner) | `gmanner~tradingview-screener-api` | 0.002 per run + 0.0004 per screener row, 0.001 per snapshot row |

## How to run (any Actor)

```bash
# 1. start a run and wait up to 120 s
curl -s -X POST "https://api.apify.com/v2/acts/<actorId>/runs?token=$APIFY_TOKEN&waitForFinish=120" \
  -H "content-type: application/json" -d '<input json>'
# 2. read results (defaultDatasetId is in the run response)
curl -s "https://api.apify.com/v2/datasets/<defaultDatasetId>/items?token=$APIFY_TOKEN&format=json"
```

Always set `maxResults` so the cost is bounded, and tell the user the expected cost (results x unit price) before starting.

## Inputs

**overture-local-leads**
```json
{"bbox": "-97.76,30.26,-97.73,30.28", "categories": ["restaurant", "cafe"], "websiteFilter": "without_website", "requirePhone": true, "maxResults": 200}
```
Or `centerLat`, `centerLon`, `radiusKm`. Output fields: name, category, categoryHierarchy, operatingStatus, confidence, hasWebsite, website, phone, street, city, region, postcode, country, lat, lon, brand, googleMapsUrl, sourceDatasets, overtureRelease.

**sitemap-extractor-plus**
```json
{"startUrls": [{"url": "https://www.example.com"}], "changedSince": "7d", "checkStatus": false, "maxResults": 5000}
```
Output fields: url, lastmod, changefreq, priority, site, section, sitemapUrl, sitemapRoot, sitemapKind, sitemapDepth, hreflang, images, status (when checked). The last row is a `SUMMARY` with per-sitemap status.

**google-play-app-intel**
```json
{"mode": "detail", "appIds": ["com.spotify.music"], "country": "us", "lang": "en"}
{"mode": "search", "queries": ["budget planner"], "maxResults": 20}
{"mode": "chart", "category": "FINANCE", "collection": "TOP_FREE", "country": "gb", "maxResults": 50, "fullDetail": false}
{"mode": "developer", "developerIds": ["Spotify AB"]}
```
Output fields (detail): appId, title, developer, installsText, minInstalls, maxInstalls, score, ratingsCount, histogram, price, offersIAP, iapRange, adSupported, updated, version, dataSafety, url.

**bienici-fr-listings**
```json
{"transactionType": "buy", "locations": ["Lyon"], "propertyTypes": ["flat"], "minPrice": 150000, "maxPrice": 400000, "minSurface": 40, "minRooms": 2, "maxRooms": 4, "maxResults": 200}
{"transactionType": "rent", "locations": ["69003", "69007"], "maxPrice": 1500, "energyClasses": ["A", "B", "C", "D"], "maxResults": 100}
```
Locations accept city names, arrondissements (Paris 11e), postcodes or departments; `publishedSince` (24h, 7d, ISO date) stops the run at the date cutoff with the default newest-first sort. Property types: flat, house, parkingbox, terrain, loft, shop, building, castle, premises, office, townhouse, programme, others. Main output fields: id, url, transactionType, propertyType, title, price, pricePerSquareMeter, priceHasDecreased, surface, rooms, bedrooms, energyClass, energyValue, ghgClass, city, postalCode, departmentCode, lat, lon, locationPrecisionMeters, publicationDate, isNewBuild, isProfessional, accountType, advertiserName, photoCount (plus amenities flags, fees, description and photos when requested).

**shopify-app-stack-leads**
```json
{"storeUrls": [{"url": "https://allbirds.com"}, {"url": "https://beardbrand.com"}], "fetchProducts": true, "extractEmails": true, "onlyShopify": false, "maxStores": 100}
```
`storeUrls` items are `{"url": ...}` objects; or pass `storeList` with one domain per line. Main output fields: domain, isShopify, storefrontType (liquid, headless, not-shopify, blocked, unavailable, unreachable), myshopifyDomain, themeName, themeSchemaName, themeSchemaVersion, themeStoreId, currency, country, city, productCount, collectionCount, lastProductUpdate, priceMin, priceMax, topVendors, apps (name, category, evidence), appNames, appCount, appsByCategory, plusHints, likelyShopifyPlus, contactEmail, contactEmails, social, error.

**kalshi-weather-edge**
```json
{"seriesTickers": ["KXHIGHNY", "KXLOWTNYC", "KXRAIN"], "maxDaysAhead": 3, "includeOrderbook": true, "maxMarkets": 200}
{"seriesTickers": ["KXHIGH*"], "cities": ["Chicago", "Denver"], "sigmaScale": 1.5, "includeUnscored": false}
```
Main output fields: ticker, seriesTicker, kind, title, bracketLabel, city, stationCode, targetDate, leadDays, bracketLow, bracketHigh, yesBid, yesAsk, yesMid, volume, openInterest, bookYesBidSize, bookYesAskSize, nwsHigh, nwsLow, nwsPop, openMeteoHigh, openMeteoLow, openMeteoPop, observedHighSoFar, observedLowSoFar, forecastValue, sigma, modelProbability, edge, scored, notes. The model is descriptive (normal bracket probability around the mean forecast with a stated sigma); nothing here is trading advice.

**google-news-feed**
```json
{"queries": ["Tesla when:1d", "Federal Reserve rates"], "topics": ["TECHNOLOGY"], "language": "en", "country": "US", "maxResults": 50, "decodeUrls": true, "fetchArticleText": false}
```
Topics: TOP, WORLD, NATION, BUSINESS, TECHNOLOGY, ENTERTAINMENT, SPORTS, SCIENCE, HEALTH; `feedUrls` accepts news.google.com topic or search URLs; `publishedSince` takes ISO or 2h/24h/7d. Output fields: title, publisher, publisherUrl, url (decoded), googleUrl, decoded, publishedAt, snippet, query, topic, feedUrl, language, country, articleText (when requested).

**yahoo-finance-data**
```json
{"mode": "quotes", "symbols": ["AAPL", "005930.KS", "BTC-USD", "EURUSD=X"]}
{"mode": "history", "symbols": ["AAPL"], "interval": "1d", "range": "5y", "includeEvents": true}
{"mode": "fundamentals", "symbols": ["AAPL"], "modules": ["financialData", "defaultKeyStatistics", "earnings"]}
{"mode": "options", "symbols": ["AAPL"], "optionsExpirations": 2, "includeGreeks": true}
{"mode": "search", "queries": ["samsung electronics"]}
{"mode": "news", "symbols": ["AAPL"], "maxResults": 15}
```
Rows carry recordType, symbol, asOf, currency, exchange plus the mode's fields (quote fields, OHLCV bars with adjClose, dividend/split rows, fundamentals module data, option contracts with delta/gamma/theta/vega/rho, search hits, news items).

**espn-sports-data**
```json
{"mode": "scoreboard", "leagues": ["nba", "nhl", "epl"], "date": "yesterday"}
{"mode": "standings", "leagues": ["nfl", "epl", "f1"]}
{"mode": "game", "leagues": ["nba"], "eventIds": ["401..."], "includePlayByPlay": true}
{"mode": "odds", "leagues": ["nfl"], "date": "today", "allOddsProviders": true}
{"mode": "schedule", "leagues": ["nba"], "teams": ["LAL"]}
```
Modes: scoreboard, schedule, standings, game, teams, roster, injuries, news, odds, rankings. League codes: nfl, nba, wnba, mlb, nhl, ncaaf, ncaam, ncaaw, epl, laliga, bundesliga, seriea, ligue1, mls, ucl, uel, world-cup, soccer-all, atp, wta, pga, lpga, ufc, f1, nascar, indycar, ipl, or any ESPN sport/league path. Dates: today, yesterday, tomorrow, a day, a span (up to 45 days), a month or a season year; times default to America/New_York. Rows share one shape: league, eventId, date (UTC), status, home/away team ids, names, scores, records, venue, broadcasts, odds (spread, total, moneylines, opening line), leaders, url.

**tradingview-screener-api**
```json
{"market": "america", "preset": "large-cap-gainers", "maxResults": 50}
{"market": "crypto", "filters": [{"left": "exchange", "operation": "equal", "right": "BINANCE"}], "columns": ["name", "close", "volume", "change"], "sort": {"field": "volume", "order": "desc"}}
{"mode": "snapshot", "symbols": ["NASDAQ:AAPL", "KRX:005930"]}
{"mode": "fields", "market": "america"}
```
Markets: america, global, crypto, coin, forex, cfd, bond, futures and country markets (korea, japan, germany, uk, india, brazil, ...). Rows: symbol, exchange, name, market, asOf plus every requested column under the scanner's own names. Unknown columns come back null and are listed in SUMMARY.notes; wrong operators or value types fail with the scanner's message and no charge.

## Limits
- Overture data is a monthly release (no live hours or reviews).
- Some CDNs refuse sitemap fetches (reported in SUMMARY, not charged).
- Google Play parsing follows the public page; English pages have the data-safety card.
- Bien'ici coordinates are blurred 50 to 250 m by the site and price history is not exposed; Paris rentals are sparse there.
- Shopify app detection sees only what the homepage loads; Plus is a hint, not a fact; some stores answer 429 to non-browser clients (reported as blocked, not charged).
- Kalshi lists weather markets only one or two days ahead; sigma per station is an assumption stated in the output; international series are listed but not modelled in Celsius yet.
- Google News RSS returns at most 100 items per query and 30–70 per topic; publication and story pages have no RSS (use site: queries); some publishers block article-text fetches.
- Yahoo Finance quote/fundamentals/options need a cookie-and-crumb handshake that shared cloud IPs can occasionally be refused; the Actor falls back to chart metadata for quotes and reports blocked endpoints in SUMMARY.
- ESPN data comes from the public JSON used by its own site; date ranges are fetched day by day (2 requests/s), betting lines appear only where a market exists (DraftKings featured line), and tennis/golf season payloads are large.
