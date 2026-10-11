# Bien'ici France Listings

Sale and rental listings from [Bien'ici](https://www.bienici.com), the French portal run by the main estate-agent networks, as a clean dataset: price, surface, rooms, DPE energy class, city and postcode, coordinates, publication date, agency or private advertiser, and a price-drop flag. Search any city, arrondissement, postcode or department with the same filters the site offers (transaction type, property type, price, surface, rooms, energy class, new-build).

Requests go to the site's own JSON search endpoint at one per second, with retries. No login, no proxies, no browser.

## What you can do with it

- **Market monitoring** - run daily with `publishedSince: 24h` for a city and get only the new listings; the run stops as soon as it reaches older ones.
- **Pricing studies** - price per square metre by postcode, DPE class or property type, with the agency fee split (`price` vs `priceWithoutFees`, `feesChargedTo`).
- **Energy-renovation leads** - filter `energyClasses: ["F", "G"]` for sale listings that fall under the French rental ban on poorly rated homes.
- **Agency intelligence** - which networks list what, exclusivity mandates, price drops (`priceHasDecreased`), days on market from `publicationDate`.
- **Map and geo work** - every row carries `lat`/`lon` (blurred by the site to a 50-250 m disk; `locationPrecisionMeters` says how much) and the INSEE district name.

## Input

| Field | Meaning |
|---|---|
| `transactionType` | `buy` (vente) or `rent` (location). |
| `locations` | City names (`Lyon`), arrondissements (`Paris 11e`), postcodes (`69003`), departments (`Rhône`) or raw zone ids. Resolved through the site's location search; the match is logged and written to `SUMMARY`. Empty = all of France. |
| `propertyTypes` | `flat`, `house`, `parkingbox`, `terrain`, `loft`, `shop`, `building`, `castle`, `premises`, `office`, `townhouse`, `programme`, `others`. New-build programme lots only appear when `programme` is requested. |
| `minPrice` / `maxPrice`, `minSurface` / `maxSurface`, `minRooms` / `maxRooms`, `minBedrooms` | Numeric filters applied by the site. |
| `energyClasses` | DPE classes to keep, e.g. `["A","B","C"]`. |
| `newBuild` | `any`, `only`, `exclude`. |
| `publishedSince` | `2026-10-01`, an ISO datetime, or `24h` / `7d` / `2w` / `1m`. |
| `sortBy` / `sortOrder` | `publicationDate` (default, newest first), `relevance`, `price`, `surfaceArea`, `pricePerSquareMeter`. |
| `maxResults` | Hard cap (default 300, up to 5,000); the run cost cannot exceed it. |
| `includeDescription`, `includePhotos` | Full French description (on by default) and photo URL list (off by default). |
| `extraFilters` | Raw keys merged into the site's filter JSON, e.g. `{"hasTerrace": true, "maxPricePerSquareMeter": 6000}`. |

Minimal input:

```json
{ "transactionType": "buy", "locations": ["Lyon"], "propertyTypes": ["flat"], "maxPrice": 400000, "publishedSince": "7d", "maxResults": 500 }
```

## Output

One row per listing:

```json
{
  "id": "guy-hoquet-18-GT0648-5259",
  "url": "https://www.bienici.com/annonce/vente/lyon-9e/appartement/3pieces/guy-hoquet-18-GT0648-5259",
  "transactionType": "sale",
  "propertyType": "flat",
  "title": "Appartement",
  "price": 289000,
  "priceWithoutFees": null,
  "pricePerSquareMeter": 3844,
  "priceHasDecreased": false,
  "priceHistory": null,
  "feesChargedTo": "seller",
  "annualCondominiumFees": 1956,
  "surface": 75.19,
  "rooms": 3,
  "bedrooms": 2,
  "floor": 1,
  "energyClass": "C",
  "energyValue": 124,
  "ghgClass": "C",
  "ghgValue": 24,
  "heating": "radiateur gaz individuel",
  "city": "Lyon 9e",
  "postalCode": "69009",
  "departmentCode": "69",
  "district": "Champvert - Gorge de Loup",
  "lat": 45.7715,
  "lon": 4.7987,
  "locationPrecisionMeters": 250,
  "publicationDate": "2026-10-10T20:55:10.255Z",
  "modificationDate": "2026-10-10T20:55:10.255Z",
  "isNewBuild": false,
  "isProfessional": true,
  "accountType": "agency",
  "advertiserName": "Guy Hoquet Lyon 9",
  "advertiserAccountId": "guy-hoquet-18",
  "isExclusiveMandate": false,
  "hasTerrace": false,
  "hasCellar": false,
  "isInCondominium": true,
  "photoCount": 6,
  "description": "Votre agence immobilière Guy Hoquet Lyon 9ème vous propose à la vente ...",
  "scrapedAt": "2026-10-11T00:46:56.107Z"
}
```

Also included: `propertySubtype`, `agencyFeePercentage`, `landSurface`, `bathrooms`, `floorCount`, `availableDate`, `isBienIciExclusive`, `hasBalcony`, `hasGarden`, `hasPool`, `hasElevator`, `parkingPlaces`, `workToDo`, `opticalFiberStatus`, `reference`, `virtualTourCount`, `addressKnown`, and `photos` when requested. `accountType` is one of `agency`, `mandatary`, `network`, `developer`, `broker` or private.

The key-value store record `SUMMARY` has the resolved locations (name, type, INSEE code, zone ids), the exact filter JSON sent to the site, the site's total match count and the stop reason, so a short result is explainable without reading the log.

## Pricing

Pay per event, no subscription:

| Event | Price |
|---|---|
| Run start | $0.005 |
| Listing | $0.0025 |

Examples: 300 listings cost $0.005 + 300 x $0.0025 = **$0.76**; a daily `publishedSince: 24h` run that finds 40 new listings in a city costs $0.105. Set `maxResults` to cap the spend.

## Speed and limits

- One request per second, up to 200 listings per request: 1,000 listings take about 10 seconds plus one second per location lookup.
- `priceHasDecreased` is the site's own flag. The public search feed does not expose the earlier prices, so `priceHistory` is `null` unless the site starts returning it; `modificationDate` tells when the ad last changed.
- Coordinates are deliberately blurred by Bien'ici (`locationPrecisionMeters`, usually 50-250 m) unless the agency publishes the exact address (`addressKnown`).
- Advertiser names are present on about half the listings in the feed; `advertiserAccountId` (the network account slug) is always present.
- The site's search is capped by its own engine at a few thousand results per query; split large searches by arrondissement or price band rather than raising `maxResults`.
- Private-seller listings are a small share of Bien'ici (it is agency-led); for private-seller coverage pair it with a leboncoin dataset.

## Local test

`npm test` runs the Actor against the live site: a filtered Lyon sale search (checks price/surface/rooms/postcode/coordinate bounds, sort order, DPE coverage), a Lyon rental search by postcode with a DPE filter and photos, an all-France `publishedSince` search that must stop early, and two invalid inputs that must fail without rows.
