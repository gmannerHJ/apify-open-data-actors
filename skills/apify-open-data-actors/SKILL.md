---
name: apify-open-data-actors
description: Get local business leads (Overture Maps), full sitemap URL lists with lastmod and status, and Google Play app intelligence through three pay-per-result Apify Actors. Use when a task needs businesses in an area, all URLs of a website, or app-store data, and the user has an Apify token (APIFY_TOKEN). Each run costs fractions of a cent per result; quote the price before running.
---

# Apify open-data Actors

Three Actors on the Apify Store, each returning a clean dataset and charging per result. You need `APIFY_TOKEN` (free Apify account; the free plan includes $5 of monthly usage).

| Need | Actor id | Price (USD) |
|---|---|---|
| Businesses in a bounding box or radius, with phone / website flag / address | `gmanner~overture-local-leads` | 0.003 per run + 0.003 per lead |
| Every URL a site lists in its sitemaps, with lastmod, optional HTTP status | `gmanner~sitemap-extractor-plus` | 0.003 per run + 0.0004 per URL (+0.0003 per status check) |
| Google Play app details / search / top charts / developer portfolio | `gmanner~google-play-app-intel` | 0.005 per run + 0.002 per app (0.003 per search term) |

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

## Limits
- Overture data is a monthly release (no live hours or reviews).
- Some CDNs refuse sitemap fetches (reported in SUMMARY, not charged).
- Google Play parsing follows the public page; English pages have the data-safety card.
