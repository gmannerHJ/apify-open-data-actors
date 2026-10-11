# Yahoo Finance Data

Market data from Yahoo Finance's public JSON endpoints, one mode per run: **quotes**, **history** (OHLCV bars from 1 minute to 1 month with dividends and splits), **fundamentals** (any `quoteSummary` module as plain numbers), **options** (full chains with computed Greeks), **search** (names and ISINs to symbols) and **news**. Works for every instrument Yahoo lists: US and international stocks (`005930.KS`, `7203.T`, `SAP.DE`, `RELIANCE.NS`), ETFs, indices (`^GSPC`), crypto (`BTC-USD`), FX (`EURUSD=X`) and futures (`GC=F`).

The Actor performs Yahoo's cookie-and-crumb handshake itself (with the EU consent flow as fallback), caches it for the run, refreshes it on 401/403, retries 429 and 5xx with backoff and keeps to five requests per second. No browser, no API key, no proxies needed from a normal network.

## What you can do with it

- **Watchlists and dashboards** - quotes for hundreds of symbols in one call per 50; schedule it every few minutes during market hours.
- **Backtesting and research** - daily history back to the first trade with adjusted prices, dividends and splits; intraday 1-minute bars for the last 30 days, automatically fetched in 7-day windows.
- **Screening and valuation** - the fundamentals modules you choose (statements, key statistics, analyst recommendations, earnings dates, holders) as numeric fields, not formatted strings.
- **Options analytics** - every contract with bid/ask, volume, open interest, implied volatility and Black-Scholes Greeks, across as many expirations as you need.
- **Symbol resolution and news** - turn company names or ISINs into tickers; pull the latest headlines per symbol with publisher and time.

## Modes and input

| Mode | Input used | One row is |
|---|---|---|
| `quotes` | `symbols` | a symbol's current quote (60+ fields) |
| `history` | `symbols`, `interval`, `range` or `startDate`/`endDate`, `adjusted`, `includeEvents`, `includePrePost` | a bar (`recordType: bar`), a dividend, a split or a capital gain |
| `fundamentals` | `symbols`, `modules` | one module for one symbol (`module`, `data`) |
| `options` | `symbols`, `optionsExpirations` or `optionsExpirationDates`, `includeGreeks` | one call or put contract |
| `search` | `queries` | one matching symbol |
| `news` | `symbols` | one headline |

`maxResults` caps rows per symbol (bars, contracts, news items) or per query; `region` and `lang` localise names and news. Up to 500 symbols per run.

```json
{ "mode": "history", "symbols": ["AAPL", "005930.KS", "SAP.DE"], "interval": "1d", "range": "5y" }
```

```json
{ "mode": "fundamentals", "symbols": ["MSFT"], "modules": ["summaryDetail", "financialData", "incomeStatementHistory", "calendarEvents"] }
```

```json
{ "mode": "options", "symbols": ["AAPL", "SPY"], "optionsExpirations": 4 }
```

## Output

Every row carries `recordType`, `symbol`, `asOf` (ISO 8601), `currency`, `exchange` and `fetchedAt`, then the fields of its kind.

Quote (abridged; all of Yahoo's numeric quote fields are included):

```json
{
  "recordType": "quote", "symbol": "AAPL", "asOf": "2026-10-09T20:00:00.000Z", "currency": "USD", "exchange": "NMS",
  "fullExchangeName": "NasdaqGS", "quoteType": "EQUITY", "shortName": "Apple Inc.", "marketState": "CLOSED",
  "regularMarketPrice": 336.64, "regularMarketChange": -3.78, "regularMarketChangePercent": -1.11,
  "regularMarketPreviousClose": 340.42, "regularMarketOpen": 331.79, "regularMarketDayHigh": 338.61, "regularMarketDayLow": 330.7,
  "regularMarketVolume": 37821157, "bid": 336.5, "ask": 336.8, "marketCap": 4912984883200, "trailingPE": 38.605507, "forwardPE": 35.11173,
  "epsTrailingTwelveMonths": 8.72, "dividendYield": 0.32, "fiftyTwoWeekLow": 243.42, "fiftyTwoWeekHigh": 345.34,
  "fiftyDayAverage": 318.2, "twoHundredDayAverage": 281.4, "averageDailyVolume3Month": 45268204, "sharesOutstanding": 14594180000,
  "postMarketPrice": 336.08, "earningsTimestamp": 1793649600, "source": "quote", "fetchedAt": "2026-10-11T05:40:12.000Z"
}
```

History bar:

```json
{ "recordType": "bar", "symbol": "AAPL", "asOf": "2026-10-09T13:30:00.000Z", "date": "2026-10-09", "interval": "1d", "currency": "USD", "exchange": "NMS",
  "open": 331.79, "high": 338.61, "low": 330.7, "close": 336.64, "volume": 37821157, "adjClose": 336.64, "adjOpen": 331.79, "adjHigh": 338.61, "adjLow": 330.7 }
```

Dividend: `{ "recordType": "dividend", "symbol": "AAPL", "asOf": "2026-08-10T13:30:00.000Z", "date": "2026-08-10", "amount": 0.27 }`. Split: `numerator`, `denominator`, `splitRatio`.

Fundamentals: `{ "recordType": "fundamentals", "symbol": "AAPL", "module": "financialData", "currency": "USD", "exchange": "NMS", "data": { "currentPrice": 336.64, "targetMeanPrice": 352.1, "recommendationKey": "buy", "totalRevenue": 416161000000, "grossMargins": 0.4698, "freeCashflow": 98700000000, ... } }`. Yahoo's `{raw, fmt}` pairs are reduced to the raw number; statement modules keep their arrays of periods.

Option: `{ "recordType": "option", "symbol": "AAPL", "contractSymbol": "AAPL261017C00335000", "optionType": "call", "expiration": "2026-10-17", "daysToExpiration": 6.1, "strike": 335, "lastPrice": 6.2, "bid": 6.1, "ask": 6.3, "mid": 6.2, "volume": 4120, "openInterest": 9876, "impliedVolatility": 0.287, "inTheMoney": true, "underlyingPrice": 336.64, "delta": 0.56, "gamma": 0.031, "theta": -0.41, "vega": 0.17, "rho": 0.03, "riskFreeRate": 0.0398 }`.

Search: `symbol`, `shortName`, `longName`, `exchange`, `exchangeDisplay`, `quoteType`, `typeDisplay`, `sector`, `industry`, `score`. News: `uuid`, `title`, `publisher`, `url`, `publishedAt`, `type`, `thumbnailUrl`, `relatedTickers`, `source` (`search`, or `rss` when the JSON endpoint has nothing).

The key-value store record `SUMMARY` has the session strategy used, request counts, rows by type, any endpoint that answered 401/403/429 persistently, and every failed symbol or module with Yahoo's error text (for example "No data found, symbol may be delisted").

## Pricing

Pay per event:

| Event | Price | Charged when |
|---|---|---|
| Run start | $0.002 | once per run |
| Quote row | $0.0005 | per symbol in quotes mode |
| History, 100 bars | $0.005 | per started block of 100 rows per symbol (bars plus dividend and split rows) |
| Fundamentals module | $0.002 | per symbol and module |
| Option contract | $0.0003 | per call or put row |
| Search match | $0.0002 | per symbol returned by a query |
| News row | $0.001 | per headline |

Examples: quotes for 200 symbols cost $0.002 + 200 x $0.0005 = **$0.10**. Five years of daily bars for 10 stocks (about 1,260 bars plus dividends each, 13 blocks per symbol) cost $0.002 + 130 x $0.005 = **$0.65**. Seven fundamentals modules for 50 companies cost $0.70. Two expirations of AAPL and TSLA (about 300 contracts) cost $0.09.

## Speed and limits

- Five requests per second, two symbols in flight. Quotes are batched 50 symbols per request; history and fundamentals are one request per symbol (1-minute bars: one per 7-day window); options are one request per expiration.
- Yahoo's data limits apply: 1-minute bars for the last 30 days, 2- to 90-minute bars for 60 days, hourly bars for 730 days; daily and coarser bars back to the first trade. Requests outside those windows return Yahoo's error text in `SUMMARY`.
- When the history window holds more than `maxResults` rows, the most recent rows are kept.
- Greeks are a Black-Scholes approximation from Yahoo's implied volatility, the underlying's last price and the 13-week T-bill yield, with zero dividend yield; they are absent when IV is missing or near zero. Expiration is taken as 16:30 US Eastern on the listed date.
- Fund-only modules (`topHoldings`, `fundProfile`, `fundPerformance`) are empty for stocks and are reported in `SUMMARY` rather than emitted.
- The quote, quoteSummary and options endpoints need Yahoo's crumb; if the handshake fails on your network the quotes mode falls back to chart metadata per symbol (`source: chart`, fewer fields) and the other two report the failure. Chart, search and news endpoints need no crumb.
- Quotes are delayed per Yahoo's exchange agreements (real-time for Nasdaq/NYSE, 15 to 20 minutes for most others). This is public web data; check Yahoo's terms for redistribution.

## Local test

`npm test` runs the Actor against the live endpoints: quotes for 10 US and 5 non-US stocks plus an index, a crypto pair and an FX pair (plus an unknown symbol that must be reported, not crash), five years of daily history for three symbols with dividends, five days of 1-minute bars for two symbols, a 30-day 1-minute request split into 7-day windows, default and explicit fundamentals modules, two expirations of options with Greeks, search by name, news for three symbols, and three invalid inputs that must fail without rows.
