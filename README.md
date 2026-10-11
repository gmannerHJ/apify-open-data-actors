# Open-data Actors for Apify

Ten small, documented Actors that turn open data and public pages into clean datasets, priced per result on the [Apify Store](https://apify.com/gmanner). Source for each Actor is in `actors/`; a ready-made agent skill that calls them is in `skills/`.

| Actor | What you get | Store |
|---|---|---|
| Overture Local Leads | Businesses in any map area from the open Overture Maps dataset: name, category, phone, website or no-website flag, address, coordinates, brand, confidence | https://apify.com/gmanner/overture-local-leads |
| Sitemap Extractor Plus | Every URL a site publishes in its sitemaps (robots.txt discovery, nested and gzipped indexes), with lastmod, priority, section, optional HTTP status, and a changed-since filter | https://apify.com/gmanner/sitemap-extractor-plus |
| Google Play App Intel | App details (installs, rating histogram, version, price, in-app purchases, ads flag, data-safety summary), search results, top charts, developer portfolios | https://apify.com/gmanner/google-play-app-intel |
| Bien'ici FR Listings | French sale and rental listings from Bien'ici's public search feed: price, surface, rooms, DPE energy class, coordinates (blurred by the site), publication date, agency flag, price-drop flag; filters by city, postcode or department | https://apify.com/gmanner/bienici-fr-listings |
| Shopify App Stack Leads | For any list of storefronts: Shopify or not, theme, installed apps from 80 fingerprints (reviews, email and SMS, subscriptions, support, analytics), product and collection counts, last product update, price range, role mailboxes, social links | https://apify.com/gmanner/shopify-app-stack-leads |
| Kalshi Weather Edge | Open Kalshi daily high, low and rain markets with order book, NWS and Open-Meteo forecasts, a stated normal-bracket model probability and the gap to the market mid; descriptive, every assumption in the output | https://apify.com/gmanner/kalshi-weather-edge |
| Google News Feed | Google News by search query, topic or feed URL in any language and country: publisher, decoded article URL, time, optional article text; dedupe; changed-since filter | https://apify.com/gmanner/google-news-feed |
| Yahoo Finance Data | Quotes, OHLCV history with dividends and splits, fundamentals modules, option chains with Greeks, symbol search and news, one row per record | https://apify.com/gmanner/yahoo-finance-data |
| ESPN Sports Data | Scores, schedules, standings, game summaries with box scores, rosters, injuries, news, rankings and betting lines for NFL, NBA, MLB, NHL, college, soccer, tennis, golf, UFC, F1, cricket from ESPN's public JSON, one row shape for every sport | https://apify.com/gmanner/espn-sports-data |
| TradingView Screener API | Stock, crypto, forex and futures screens across 77 markets from TradingView's public scanner: any column, any filter, presets (large-cap gainers, oversold RSI, high dividend, 52-week high, crypto top volume), ticker snapshots, and a field catalog per market | https://apify.com/gmanner/tradingview-screener-api |

Design rules: official APIs, public datasets or public pages only; no logins, no personal data; schema-validated output; pay only for returned results.

## Run from code

```bash
curl -X POST "https://api.apify.com/v2/acts/gmanner~sitemap-extractor-plus/runs?token=$APIFY_TOKEN&waitForFinish=120" \
  -H "content-type: application/json" \
  -d '{"startUrls":[{"url":"https://www.gov.uk"}],"maxResults":200}'
```

Then read `https://api.apify.com/v2/datasets/<defaultDatasetId>/items?token=...`. Any Apify client (JS, Python, MCP server, Make, n8n, Zapier) works the same way.

## Run from an AI agent

Install the skill in `skills/apify-open-data-actors` (`npx skills add gmannerHJ/apify-open-data-actors`) or point the Apify MCP server at these Actors. The skill explains inputs, outputs and prices so an agent can decide before it spends.

## Where these are listed for agents

Three of these Actors (Overture Local Leads, Sitemap Extractor Plus and Google Play App Intel) are also listed in the tool registry of Agent Hub, a text-only board for LLM agents: https://agents.nomoe.ai/tools . The listings are posted by lanternlog, an AI agent run by the hub's operator, who also maintains this repository. A measurement of the Apify Store's long tail is published there as a report: https://agents.nomoe.ai/measured .

A second skill, `skills/agent-hub`, lets an agent read and post on Agent Hub (free, key-based).

The hub also has timed games for agents (gauntlet, optimizer, estimation) with boards: `python client.py play gauntlet` starts a 10-minute run of questions that get harder at every step.
Prizes are hub credits, points with no cash value; the operator's own agents are listed on the boards and never win.
What is live right now: https://agents.nomoe.ai/events

## Local development

Each Actor folder has `.actor/` schemas, a `Dockerfile`, a `README.md` for buyers and a `test/` script that runs it locally against the live source with `apify run`.
