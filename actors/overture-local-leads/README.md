# Overture Local Leads

Local business leads for any area on the map, from the open Overture Maps Places dataset (about 60 million places worldwide, refreshed monthly, sourced from Meta, Microsoft and community data). Draw a bounding box or give a centre point and radius, optionally filter by category, and get name, category, phone, website or a no-website flag, street address, coordinates, brand and a confidence score.

No Google Maps scraping, no proxies, no captchas: the data is read directly from Overture's public release with DuckDB, so runs are fast and never blocked.

## What you can do with it

- **Web design and local SEO prospecting** - `websiteFilter: without_website` with `requirePhone: true` returns businesses you can call today that have no site. In downtown Austin (2 km x 2 km) 19% of all places have no website listed.
- **Territory and market mapping** - count dentists, gyms, cafes or car dealers per neighbourhood; export with coordinates to a map.
- **CRM enrichment at scale** - 100,000 leads per run, ranked by confidence, with Overture's stable place IDs for deduplication across months.
- **Replacing per-query Maps scrapers** - one run covers a whole city instead of one search box at a time.

## Input

| Field | Meaning |
|---|---|
| `bbox` | `west,south,east,north` in decimal degrees (copy from bboxfinder.com). Up to 10 square degrees per run. |
| `centerLat`, `centerLon`, `radiusKm` | Alternative to `bbox`: a square of `radiusKm` half-width around the point. |
| `categories` | Overture category names: `restaurant`, `cafe`, `bar`, `dentist`, `plumber`, `hair_salon`, `real_estate_agent`, `lawyer`, `gym`, `hotel`, `car_dealer`, `bakery` ... Matched against the primary category, its parents and alternates, so `bar` also returns pubs and cocktail bars. |
| `websiteFilter` | `any`, `without_website`, `with_website`. |
| `requirePhone`, `minConfidence`, `countries`, `excludeClosed`, `nameContains` | Further filters. |
| `maxResults` | Cap on leads (highest confidence first). Default 1,000, maximum 100,000. |

Example:

```json
{
  "bbox": "-97.75,30.26,-97.73,30.28",
  "categories": ["restaurant", "cafe", "bar"],
  "websiteFilter": "without_website",
  "requirePhone": true,
  "minConfidence": "0.5",
  "maxResults": 500
}
```

## Output

One row per business:

```json
{
  "id": "928a635c-dcb9-4282-b2ab-4a1151ba8b2f",
  "name": "The Iron Bear",
  "category": "bar",
  "categoryHierarchy": ["food_and_drink", "alcoholic_beverage_venue", "bar"],
  "altCategories": [],
  "basicCategory": "bar",
  "operatingStatus": "open",
  "confidence": 0.9967,
  "hasWebsite": false,
  "website": null,
  "websites": [],
  "phone": "15124828993",
  "phones": ["15124828993"],
  "emails": [],
  "socials": [],
  "brand": null,
  "street": "301 W 6th St",
  "city": "Austin",
  "region": "TX",
  "postcode": "78701-2915",
  "country": "US",
  "lat": 30.268,
  "lon": -97.7456,
  "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=30.268000,-97.745600",
  "sourceDatasets": ["Microsoft", "Overture"],
  "overtureRelease": "2026-09-23.1",
  "scrapedAt": "2026-10-10T20:15:02+00:00"
}
```

`emails` and `socials` (Facebook, Instagram pages) are filled when Overture has them, which is common for places sourced from Meta. The key-value store record `SUMMARY` holds the bbox, filters, lead count and duration.

## Pricing

Pay per event:

| Event | Price |
|---|---|
| Run start | $0.003 |
| Lead | $0.003 |

200 leads cost $0.003 + 200 x $0.003 = **$0.60**; a 5,000-lead city export costs $15.00. Only rows written to the dataset are charged, so narrow filters (no website + phone + category) cost exactly what they return.

## Speed

Measured on the current release: a 2 km x 2 km downtown box returns 200 leads in about 18 seconds and a filtered no-website query in about 20 to 25 seconds, most of it the one-time scan of the parquet metadata. Larger boxes grow roughly with the number of places inside them.

## Limits

- Data comes from the monthly Overture release (default `2026-09-23.1`, selectable). It is not live: a business that opened last week is unlikely to be there yet.
- No ratings, reviews, opening hours or photos; Overture Places does not carry them. Use the `googleMapsUrl` field to look a lead up.
- Coverage and field completeness vary by country. North America and Western Europe are dense; phone numbers are present on most US records, websites on roughly 80%.
- `confidence` is Overture's own estimate that the place exists as described; 0.5 and above is a reasonable default for outreach lists.
- Phone numbers are returned as stored (mixed formats such as `+15129004740` and `15124828993`); normalise them downstream if needed.
- A single run covers at most 10 square degrees (roughly a large metro area); split countries into tiles.

Overture Maps places data is licensed under CDLA Permissive 2.0; keep the attribution when you republish it.

## Local test

`.venv/Scripts/python test/run_local.py` (Windows) or `.venv/bin/python test/run_local.py` runs four scenarios against the live S3 release and asserts the fields, counts and ordering.
