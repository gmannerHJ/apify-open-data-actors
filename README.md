# Open-data Actors for Apify

Nine small, documented Actors that turn open data and public pages into clean datasets, priced per result on the [Apify Store](https://apify.com/gmanner). Source for each Actor is in `actors/`; a ready-made agent skill that calls them is in `skills/`.

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

## Local development

Each Actor folder has `.actor/` schemas, a `Dockerfile`, a `README.md` for buyers and a `test/` script that runs it locally against the live source with `apify run`.
