# Google Play App Intel

Structured data from the Google Play Store in four modes: full **app details** by package name or URL, **search results**, a **developer's portfolio**, and **top charts** by category and collection. Every detail record carries the install bucket with exact min/max counts, the five-star rating histogram, version and last update, price and in-app purchase range, ads flag, content rating, developer contact details, and the **data-safety summary** (what the app shares and collects, encryption in transit, deletion requests).

Requests run at one per second per run, with retries and no login or proxies. The data-safety summary is parsed from the same page load as the details, so it costs no extra request.

## What you can do with it

- **Competitor and market tracking** - pull your category's top 100 weekly with `fullDetail` and watch installs, ratings, version cadence and IAP ranges move.
- **App-store optimisation** - see which apps rank for your keywords in each country, with their ratings and prices.
- **Due diligence and lead lists** - a developer's whole portfolio with install counts, update recency and contact email in one run.
- **Privacy and compliance monitoring** - the data-safety card as structured fields for hundreds of apps at once.

## Modes and input

| Mode | Required input | What a row is |
|---|---|---|
| `detail` | `appIds` (package names or store URLs) | one full app record |
| `search` | `searchTerms` | one ranked search result per app (`position`) |
| `developer` | `developerIds` (name as shown on Play, or numeric id) | one app in the portfolio |
| `chart` | `chartCategory` + `chartCollection` (TOP_FREE, TOP_PAID, GROSSING) | one ranked chart entry (`rank`, `snapshotAt`) |

`country` and `language` select the store (`us`/`en` by default). `maxResults` caps results per term, per developer or per chart (up to 500). `fullDetail: true` turns every list entry into a full app record.

```json
{ "mode": "chart", "chartCategory": "FINANCE", "chartCollection": "TOP_FREE", "country": "gb", "maxResults": 100, "fullDetail": true }
```

## Output

Detail record (abridged):

```json
{
  "recordType": "app",
  "appId": "com.spotify.music",
  "url": "https://play.google.com/store/apps/details?id=com.spotify.music&hl=en&gl=us",
  "title": "Spotify: Music and Podcasts",
  "developer": "Spotify AB",
  "developerId": "Spotify+AB",
  "developerEmail": "android-support@spotify.com",
  "genre": "Music & Audio",
  "genreId": "MUSIC_AND_AUDIO",
  "installsText": "1,000,000,000+",
  "minInstalls": 1000000000,
  "maxInstalls": 3154302792,
  "score": 4.35,
  "ratingsCount": 36459955,
  "histogram": { "1": 3713670, "2": 1063641, "3": 1312025, "4": 3098693, "5": 27271910 },
  "price": 0,
  "currency": "USD",
  "free": true,
  "offersIAP": true,
  "iapRange": "$4.99 - $203.88 per item",
  "adSupported": true,
  "contentRating": "Teen",
  "released": "May 27, 2014",
  "updated": "2026-10-07T03:07:03.000Z",
  "version": "VARY",
  "androidVersion": "VARY",
  "dataSafety": {
    "sharesData": true,
    "sharedDataTypes": "Location, Personal info, and Device or other IDs",
    "collectsData": true,
    "collectedDataTypes": "Location, Personal info and 7 others",
    "encryptedInTransit": true,
    "canRequestDeletion": true,
    "independentSecurityReview": false,
    "playFamiliesPolicy": false,
    "summary": ["This app may share these data types with third parties: Location, Personal info, and Device or other IDs", "..."]
  },
  "country": "us",
  "language": "en",
  "scrapedAt": "2026-10-10T20:40:11.512Z"
}
```

Also included: `summary`, `description`, `categories`, `developerWebsite`, `developerAddress`, `privacyPolicy`, `priceText`, `originalPrice`, `contentRatingDescription`, `recentChanges`, `icon`, `headerImage`, `screenshotCount`, `hasVideo`, `available`, `preregister`, `playPass`. List rows (`search`, `developer`, `chart`) carry `appId`, `url`, `title`, `summary`, `developer`, `developerId`, `score`, `price`, `currency`, `free`, `icon` plus the ranking fields.

The key-value store record `SUMMARY` lists request counts and every failure (for example an app id that returned 404), so a partial run is diagnosable without the log.

## Pricing

Pay per event:

| Event | Price | Charged when |
|---|---|---|
| Run start | $0.005 | once per run |
| App detail | $0.002 | per full app record (detail mode, or any list entry with `fullDetail`) |
| Search query | $0.003 | per search term, with its whole result list |
| Chart entry | $0.002 | per ranked app in a chart (light rows) |
| Developer portfolio entry | $0.002 | per app in a developer list (light rows) |

Examples: details for 25 apps cost $0.005 + 25 x $0.002 = **$0.055**. Five searches with 50 light results each cost $0.02. A top-100 chart with full details costs $0.005 + 100 x $0.002 = $0.205.

## Speed and limits

- One request per second: 100 detail records take about 100 seconds; light search, developer and chart lists take one to a few seconds each.
- The data-safety summary is parsed from English store pages (`language: en`). For other languages the field is `null`; all other fields are localised normally.
- Data-safety detail (per-purpose breakdown) and user reviews are not included; the store's separate data-safety page is excluded by Google's robots.txt and is not fetched.
- Search returns at most 250 apps per term and charts at most 500, which is what the store exposes.
- Country-restricted apps return 404 in stores where they are not listed; they appear in `SUMMARY.failures`, not as rows.
- Google changes the page's embedded data layout a few times a year; the parser is the maintained `google-play-scraper` library plus a small data-safety extractor, and both are covered by the local test (`npm test`).
