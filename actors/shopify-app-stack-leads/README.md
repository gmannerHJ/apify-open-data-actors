# Shopify App Stack Leads

Give it a list of storefront URLs and get, for each one, the Shopify theme, the apps installed (detected from the scripts and markup the storefront actually loads), currency and country, product and collection counts, when a product was last updated, Shopify Plus hints, social profiles and the public business contact email. Three stores run in parallel, half a second apart per host, with retries; no login, no browser.

The app inventory covers 80 fingerprints: email/SMS (Klaviyo, Attentive, Postscript, Omnisend), reviews (Yotpo, Judge.me, Loox, Okendo, Stamped, Reviews.io), subscriptions (Recharge, Skio, Appstle, Smartrr, Ordergroove, Seal, Bold, Loop), support (Gorgias, Zendesk, Tidio, Intercom), popups (Privy, Justuno, OptiMonk), upsells (Rebuy, Bold), loyalty (Smile.io, LoyaltyLion, Rise.ai), search (Searchanise, Boost, Klevu, Algolia, Nosto), page builders (PageFly, Shogun, GemPages), analytics and attribution (GA4, GTM, Meta, TikTok, Pinterest, Hotjar, Clarity, Triple Whale, Northbeam, Elevar), BNPL (Shop Pay, Afterpay, Klarna, Affirm, Sezzle), cross-border (Global-e, Zonos), consent banners and more. Each detection carries its evidence (the host or snippet that matched).

## What you can do with it

- **App-vendor prospecting** - stores on a competitor's review or subscription app, with a contact mailbox, ready for outreach.
- **Agency lead lists** - stores still on a theme-store theme with no email platform, or Dawn stores with 500+ products and no search app.
- **Market sizing** - adoption of an app across a list of 2,000 stores in one run; `SUMMARY` has the per-app totals.
- **Account research** - a merchant's stack, catalogue size, update cadence and markets in one row before a call.

## Input

| Field | Meaning |
|---|---|
| `storeUrls` | Storefront URLs (list editor). |
| `storeList` | Or paste domains one per line (commas/semicolons also split; `#` lines ignored). Duplicates by domain are removed. |
| `maxStores` | Cap on stores analysed (default 1,000, up to 5,000). |
| `fetchProducts` / `maxProductPages` | Read the public `/products.json` (250 per page) for last product update, price range, top vendors and types. Exact counts come from `/meta.json` either way. |
| `extractEmails` | Collect role mailboxes (`hello@`, `support@`, `wholesale@` ...) and mailboxes on the store's own domain found on the homepage. |
| `onlyShopify` | Drop reachable sites that are not on Shopify. |

```json
{ "storeList": "allbirds.com\nbeardbrand.com\ncolourpop.com\npipsnacks.com", "maxStores": 100 }
```

## Output

One row per store (abridged):

```json
{
  "storeUrl": "https://beardbrand.com",
  "domain": "beardbrand.com",
  "httpStatus": 200,
  "isShopify": true,
  "storefrontType": "liquid",
  "shopName": "Beardbrand",
  "myshopifyDomain": "beardbrand.myshopify.com",
  "shopId": 2090478,
  "themeName": "Split v1.0.3.8.4v2 [low stock highlights v2]",
  "themeSchemaName": "Split",
  "themeSchemaVersion": "3.1.0",
  "themeStoreId": 842,
  "themeSource": "theme-store",
  "currency": "USD",
  "moneyFormat": "${{amount}}",
  "locale": "en",
  "country": "US",
  "city": "Austin",
  "province": "Texas",
  "shopPayInstallments": true,
  "productCount": 66,
  "productCountSource": "meta.json",
  "collectionCount": 47,
  "lastProductUpdate": "2026-10-11T00:35:54.000Z",
  "priceMin": 5,
  "priceMax": 199,
  "topVendors": ["Beardbrand"],
  "topProductTypes": ["Beard Oil", "Beard Wash", "Utility Balm"],
  "appNames": ["Klaviyo", "Judge.me", "Recharge", "Bold Apps", "Shop Pay", "Google Tag Manager", "Meta Pixel"],
  "apps": [{ "app": "Klaviyo", "category": "email_sms", "evidence": "host:static.klaviyo.com" }, { "app": "Judge.me", "category": "reviews", "evidence": "host:cdn.judge.me" }],
  "appsByCategory": { "email_sms": ["Klaviyo"], "reviews": ["Judge.me"], "subscriptions": ["Recharge"], "upsell_bundles": ["Bold Apps"] },
  "plusHints": [],
  "likelyShopifyPlus": false,
  "contactEmail": "support@beardbrand.com",
  "contactEmails": ["support@beardbrand.com"],
  "social": { "instagram": "https://www.instagram.com/beardbrand", "youtube": "https://www.youtube.com/beardbrand" },
  "thirdPartyHosts": ["static.klaviyo.com", "cdn.judge.me", "static.rechargecdn.com"],
  "error": null,
  "fetchedAt": "2026-10-11T00:52:10.512Z",
  "durationMs": 2410
}
```

`storefrontType` is `liquid` (standard theme), `headless` (Shopify backend behind a custom front end, like gymshark.com; theme and product feed are not exposed), `not-shopify`, `blocked` (403/429), `unavailable` or `unreachable`. Rows with an `error` are kept so you can see which inputs failed; they are not charged.

The key-value store record `SUMMARY` has the counts, every failure with its HTTP status, and the number of stores per detected app.

## Pricing

Pay per event:

| Event | Price |
|---|---|
| Run start | $0.001 |
| Store analysed | $0.012 |

Examples: 20 stores cost $0.001 + 20 x $0.012 = **$0.24**; 2,000 stores cost $24.00. Unreachable or blocked stores are free.

## Speed and limits

- About 1-3 seconds per store (homepage, `/meta.json`, one product page); 1,000 stores take roughly 15 minutes at concurrency 3.
- Detection is based on what the homepage loads. Apps that only run on product, cart or checkout pages (some upsell and checkout apps) are not visible, and apps loaded lazily after consent can be missed. A detection is positive evidence; absence is not proof of absence.
- Shopify Plus is not published anywhere public. `plusHints` lists weak signals (Launchpad, `checkout.liquid`, script editor, B2B markup, several regional `myshopify` storefronts); treat `likelyShopifyPlus` as a hint.
- `lastProductUpdate` and the price range come from the first `maxProductPages` x 250 products of the public feed. Stores that disable `/products.json` (headless or password-protected) report `productCount` from `/meta.json` when available, otherwise `null`.
- Only business contact details are extracted: role mailboxes and addresses on the store's own domain. Personal mailboxes on freemail providers and named individuals on third-party domains are skipped by design.
- Some storefronts sit behind bot protection and answer 403 or 429 to any non-browser client (bombas.com at the time of writing). They are reported as `blocked`.

## Local test

`npm test` runs the Actor against live stores (Allbirds, Beardbrand, ColourPop, Pip's Snacks, Ugmonk, the headless gymshark.com, example.com and an unreachable host) and asserts theme, apps, counts, emails, storefront types, dedup and failure reporting, then checks `onlyShopify` and invalid inputs.
