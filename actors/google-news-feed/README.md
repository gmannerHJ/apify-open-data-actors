# Google News Feed

Google News headlines as a clean dataset: by **search query** (with Google's operators), by **section** (Top stories, World, Nation, Business, Technology, Entertainment, Sports, Science, Health) or from any **topic or location page** copied from news.google.com, in any of Google's editions (language + country). Each row has the headline, publisher and publisher site, the **publisher's article URL** resolved from Google's redirect link, the publication time as ISO 8601, and the query or topic that found it. Optionally the article body text.

Reads Google's RSS endpoints over plain HTTP with retries; no browser, no login, no API key. The redirect links (`news.google.com/rss/articles/...`) are resolved through Google's own redirect service, five at a time, in about 100 ms per item.

## What you can do with it

- **Brand, competitor and topic monitoring** - run every hour with `publishedSince: 1h` and a list of queries; new rows only, publisher URLs ready for your CRM or Slack.
- **News datasets for analysis and AI** - headlines across languages and countries with real article links, deduplicated, optionally with full text for summarisation or sentiment.
- **Regional editions** - the same query in `de/DE`, `fr/FR`, `ja/JP`, `pt-BR/BR`, `ko/KR`, `hi/IN` to compare coverage by market.
- **Feeds for apps and newsletters** - topic sections and publication feeds as JSON on a schedule.

## Input

| Field | Meaning |
|---|---|
| `queries` | One search per entry, up to 100 results each. Operators: `"exact phrase"`, `OR`, `-word`, `site:reuters.com`, `intitle:`, `when:1h` / `when:1d` / `when:7d`, `after:2026-10-01`. |
| `topics` | `TOP`, `WORLD`, `NATION`, `BUSINESS`, `TECHNOLOGY`, `ENTERTAINMENT`, `SPORTS`, `SCIENCE`, `HEALTH`. |
| `feedUrls` | Topic pages from news.google.com, including sub-topics (`https://news.google.com/topics/CAAq...`), and location sections (`/headlines/section/geo/New York`). Publication and story pages have no RSS feed; use `site:domain.com` queries for a publisher. |
| `language`, `country` | Edition, e.g. `en-US` + `US`, `de` + `DE`, `pt-BR` + `BR`. The edition id (`ceid`) is derived; override it only if Google uses a different one. |
| `publishedSince` | `2026-10-01`, an ISO datetime, or `2h`, `24h`, `7d`. Queries without a time operator also get `after:YYYY-MM-DD`. |
| `maxResults` | Per query or feed, up to 100 (what Google's RSS returns). |
| `decodeUrls` | Resolve publisher URLs (default on). Off: rows keep the Google link and `decoded: false`. |
| `fetchArticleText` | Download each resolved article and extract the body text (default off, charged separately). |

```json
{ "queries": ["Samsung Electronics earnings when:1d", "\"Federal Reserve\" rates"], "topics": ["BUSINESS"], "language": "en-US", "country": "US" }
```

## Output

```json
{
  "id": "CBMikwFBVV95cUxNR1hiU2pDUFhHNFJZZC0wZUZ3VHM3RGVaRDlfTWtFTUhQMms2dVlzZmJvU1JJUDR5Vl9PM2Z1UWJFbkNyRzdCNGNnMlJNTW50UEJtUVkwOEcwWm9QMzM1LTZfX3lEZzROYjNENUlFbEJWbmRSTVp3cVFCWWVGNGwxZWtWT2t5WW9iVFJkT1JUa1pucVk",
  "title": "In the US, new Tesla Model 3 and Model Y orders can now back up a home during outages",
  "publisher": "Yahoo Autos",
  "publisherUrl": "https://autos.yahoo.com",
  "url": "https://autos.yahoo.com/ev-and-future-tech/articles/us-tesla-model-3-model-011500597.html",
  "googleUrl": "https://news.google.com/rss/articles/CBMikwFBVV95cUxNR1hi...?oc=5",
  "decoded": true,
  "publishedAt": "2026-10-11T01:15:00.000Z",
  "snippet": null,
  "query": "Tesla when:1d",
  "topic": null,
  "feedUrl": "https://news.google.com/rss/search?q=Tesla%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen",
  "language": "en-US",
  "country": "US",
  "fetchedAt": "2026-10-11T05:12:40.118Z"
}
```

- `title` has the ` - Publisher` suffix Google appends removed; `publisher` and `publisherUrl` come from the feed's `<source>` element.
- `snippet` is filled only when the feed or the article page provides text beyond the headline (Google's RSS usually does not; with `fetchArticleText` the page's meta description is used).
- With `fetchArticleText`: `articleText` (JSON-LD `articleBody` when the publisher embeds it, otherwise the main article paragraphs, up to 30,000 characters), `articleTextChars`, and `articleTextStatus` (`ok`, `short`, `paywall`, `blocked`, `timeout`, `not-html`, `error`, `no-publisher-url`).
- Rows are deduplicated by article id, by canonical publisher URL (tracking parameters removed) and by headline + publisher, so the same story found by two queries appears once; `query`/`topic` names the first feed that returned it.

The key-value store record `SUMMARY` has per-feed counts and HTTP status, decoding success and timing, article-text status counts and every failure.

## Pricing

Pay per event:

| Event | Price | Charged when |
|---|---|---|
| Run start | $0.002 | once per run |
| Article | $0.001 | per row written |
| Article text | $0.004 | per row where text was actually extracted (`articleTextStatus: ok`) |

Examples: five queries returning 100 articles each with publisher URLs cost $0.002 + 500 x $0.001 = **$0.50**. The same run with article text, assuming 70% of publishers allow extraction, adds 350 x $0.004 = $1.40.

## Speed and limits

- Feeds take about half a second each; URL resolution runs five in parallel at roughly 100 ms per item (100 items in about 10 s). Article text adds 10 s per page at most, five pages in parallel, one request per second per publisher.
- Google's RSS returns at most 100 items per search and 30 to 70 per topic. For more coverage split the query by time (`when:1d` daily, or `after:`/`before:`) or by sub-topic.
- Publisher pages (`/publications/...`) and story clusters (`/stories/...`) on news.google.com have no RSS feed; Google answers them with a "feed not available" placeholder, which the Actor reports as a failed feed. A `site:` query covers a publisher instead.
- The `when:` operator counts back from now (`when:1h`, `when:1d`, `when:7d`, `when:1m`); `publishedSince` filters locally on the feed's `pubDate` as well.
- URL resolution depends on Google's redirect service. When it fails for an item, the row keeps the Google link with `decoded: false` and is still charged as an article; the failure is listed in `SUMMARY`.
- Article text is best effort: many publishers block automated readers (Reuters, AP and most paywalled sites return 401/403), which gives `blocked` and no charge. BBC, Guardian, NPR, CNBC and most regional outlets extract normally. The extractor keeps paragraphs and drops navigation, captions and boilerplate; it does not render JavaScript.
- Google's feed terms limit the RSS to personal, non-commercial feed-reader use; review them against your intended use.

## Local test

`npm test` runs the Actor against the live feeds: five queries in English, German and Korean with URL resolution (checks a 90%+ decode rate over 100+ items and the row fields), three topics with a date filter and no decoding, a custom topic URL plus Top stories in the French edition, article text on plain-HTML publishers and on a mixed set, and three invalid inputs that must fail without rows.
