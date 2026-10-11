# Sitemap Extractor Plus

Every URL a site publishes in its sitemaps, as a clean dataset: URL, last-modified date, change frequency, priority, section, and the sitemap it came from. Point it at a homepage and it reads `robots.txt`, follows sitemap indexes to any depth, decompresses `.gz` files, and dedupes the result. Optional: keep only URLs changed since a date, and check the HTTP status of each URL.

## What you can do with it

- **Content inventory** - list all pages of a site (yours or a competitor's) with per-section counts, ready for a spreadsheet or a crawler.
- **Change monitoring** - run weekly with `changedSince: 7d` to get only pages added or updated since the last run. Child sitemaps older than the cutoff are not even downloaded, so incremental runs on large sites take seconds.
- **Migration and SEO QA** - enable status checks to find sitemap URLs that 404, redirect, or point to the wrong content type.
- **Seed lists for scrapers** - feed the dataset into any crawler instead of discovering links page by page.

## Input

| Field | Meaning |
|---|---|
| `startUrls` | Homepages (robots.txt discovery, fallback to `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml` and similar) or direct sitemap URLs (`.xml`, `.xml.gz`, `.txt`, indexes). |
| `changedSince` | `2026-10-01`, an ISO datetime, or `24h` / `7d` / `2w` / `1m`. URLs without `lastmod` are dropped unless `keepUrlsWithoutLastmod` is on. |
| `includeUrlPattern` / `excludeUrlPattern` | Case-insensitive regular expressions applied to each URL. |
| `checkStatus` | HEAD request per URL (GET fallback), 5 in parallel, 200 ms apart per host. |
| `maxUrls`, `maxSitemaps`, `maxDepth` | Hard caps; the run cost cannot exceed `maxUrls`. |

Minimal input:

```json
{ "startUrls": [{ "url": "https://www.gov.uk" }], "changedSince": "7d", "maxUrls": 5000 }
```

## Output

One row per unique URL:

```json
{
  "url": "https://www.gov.uk/hmrc-internal-manuals/double-taxation-relief/dt4850pp",
  "lastmod": "2026-09-30T10:05:18.000Z",
  "lastmodRaw": "2026-09-30T11:05:18+01:00",
  "changefreq": null,
  "priority": 0.5,
  "site": "www.gov.uk",
  "section": "/hmrc-internal-manuals",
  "sitemapUrl": "https://www.gov.uk/sitemaps/sitemap_2.xml",
  "sitemapRoot": "https://www.gov.uk/sitemap.xml",
  "sitemapKind": "urlset",
  "sitemapDepth": 1,
  "discoveredVia": "input",
  "alternatesCount": 0,
  "alternates": null,
  "imageCount": 0,
  "videoCount": 0,
  "newsTitle": null,
  "newsPublicationDate": null
}
```

With `checkStatus` each row also gets `status`, `redirected`, `finalUrl`, `contentType` and `statusCheckedAt`. `alternates` holds `hreflang` links, `newsTitle` / `newsPublicationDate` come from Google News sitemaps, and RSS/Atom feeds listed as sitemaps are accepted too.

The key-value store record `SUMMARY` has the run statistics, per-section counts and one entry per sitemap file (kind, HTTP status, URL count, error), so a failing or empty sitemap is visible without reading logs.

## Pricing

Pay per event, no subscription:

| Event | Price |
|---|---|
| Run start | $0.003 |
| URL listed | $0.0004 |
| URL status checked (optional) | $0.0003 |

Examples: 2,000 URLs cost $0.003 + 2,000 x $0.0004 = **$0.80**; the same run with status checks costs $1.40. A weekly `changedSince: 7d` run that finds 150 changed pages costs $0.06. Set `maxUrls` to cap the spend.

## Limits

- Only URLs the site publishes in sitemaps are returned; pages missing from the sitemap are not discovered.
- Some sites answer sitemap requests with 403 or an HTML challenge from their CDN (seen on nytimes.com and npmjs.com). Those sitemaps are reported in `SUMMARY` with their status and skipped; the run continues with the others.
- `lastmod` is whatever the site declares; many sites omit it or set it to the crawl time. Rows keep the raw value in `lastmodRaw` so you can judge it.
- Sitemap files are parsed in memory; the spec's 50 MB uncompressed limit per file is fine, multi-hundred-MB files are not.
- Status checks are deliberately slow (5 parallel, 200 ms per host) to stay polite; 10,000 checks take about 7 minutes.

## Local test

`npm test` runs the Actor against a local synthetic site (robots discovery, gzipped index, nested, text sitemap, `changedSince`, status checks) and against gov.uk, bbc.com and apify.com, then asserts the dataset fields.
