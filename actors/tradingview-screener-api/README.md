# TradingView Screener API

Screener results from TradingView's public scanner endpoint (`scanner.tradingview.com/{market}/scan`) as a clean dataset: any of the scanner's columns, any filter the TradingView screener UI can express, ready-made presets, exact-ticker snapshots across exchanges, and a catalog of the column names each market supports. 70 country stock markets (United States, Canada, United Kingdom, Germany, France, Japan, South Korea, India, China, Hong Kong, Taiwan, Brazil, Australia and more), crypto pairs on every exchange, aggregated crypto coins, forex, CFDs, bonds and futures.

**Descriptive data only.** Values are what the scanner reports (prices, volumes, fundamentals, indicator values, TradingView's technical rating number); nothing here is a recommendation.

## What you can do with it

- **Daily screens into a sheet or database** - gainers, oversold names, dividend payers, new highs, most active, per market, with the columns you choose.
- **Multi-market watchlists** - one snapshot call for a mixed list such as `NASDAQ:AAPL, KRX:005930, BINANCE:BTCUSDT, FX:EURUSD`.
- **Universe building** - pull a whole market with fundamentals and technicals. The `america` scanner lists 20,328 symbols (stocks, funds, depositary receipts, OTC); 6,110 of them are primary-listed active stocks, 4,871 on NASDAQ, NYSE and AMEX (counts on 2026-10-11).
- **Column discovery** - mode `fields` lists the 3,000+ field names a market supports, with the allowed values of enumerated fields (sectors, exchanges, types) and a sample value for each field.

## How it works

1. Screener mode sends the filters, sort and columns to `POST scanner.tradingview.com/{market}/scan` and pages through the result 500 rows at a time (`range`), one request per second, until `maxResults` or the end of the match list.
2. Snapshot mode sends exact tickers (`symbols.tickers`) in batches of 200 to the global scanner, so tickers from different exchanges can be mixed.
3. Fields mode reads `GET scanner.tradingview.com/{market}/metainfo` (the scanner's own field catalog with types and enumerated values), then verifies the list with one scan of the three largest symbols requesting every listed column: each field gets `verified`, a `sampleValue` and the `sampleSymbol` it came from. `global` has no catalog, so the Actor probes a curated list of 160 names and keeps the ones that return values.
4. Every row carries `symbol`, `exchange`, `name`, `market`, each requested column under its native name, and `asOf`.
5. Requests the scanner rejects with HTTP 400 fail the run with the scanner's own message, for example `Unsupported num operation match` or `expected value(s) is string type in the right operand`, and are not charged. The scanner does not reject unknown names: an unknown column comes back as `null` and an unknown filter field matches nothing. The Actor lists columns that were null in every row, and explains an empty result, in the `notes` of the `SUMMARY` record.

## Input

| Field | Meaning |
|---|---|
| `mode` | `screener` (default), `snapshot`, `fields`. |
| `market` | `america`, `korea`, `japan`, `germany`, `uk`, `india`, `brazil`, `australia`, `canada`, `france`, `hongkong`, `china`, `taiwan` and 57 more country markets; `crypto`, `coin`, `forex`, `cfd`, `bond`, `futures`, `global`. Default `america` (`coin` for the crypto preset). |
| `columns` | Scanner field names. Default: the 27 columns listed below. |
| `preset` | One of the presets below, or `none`. |
| `filters` | `[{left, operation, right}]`, ANDed. `right` may be a number, string, boolean, array (for `in_range`, `has`) or another field name (column-to-column comparison). |
| `filter2` | Optional scanner `filter2` object for OR groups, passed through. |
| `symbols` | Exact tickers for snapshot mode (`EXCHANGE:TICKER`). |
| `sortBy`, `sortOrder` | Sort field and direction (`auto`, `desc`, `asc`). Default: the preset's sort, else `market_cap_basic` for stock markets and `volume` for the others, descending. |
| `maxResults` | Up to 20,000 rows (screener) or symbols (snapshot). |

Default columns: `name, close, change, change_abs, volume, market_cap_basic, price_earnings_ttm, earnings_per_share_basic_ttm, dividends_yield, sector, industry, Recommend.All, RSI, SMA50, SMA200, Perf.W, Perf.1M, Perf.YTD, Volatility.D, relative_volume_10d_calc, exchange, type, description, currency, average_volume_10d_calc, float_shares_outstanding, beta_1_year`.

```json
{ "market": "korea", "preset": "large-cap-gainers", "maxResults": 100 }
```

```json
{
  "market": "america",
  "filters": [
    { "left": "exchange", "operation": "in_range", "right": ["NASDAQ", "NYSE"] },
    { "left": "market_cap_basic", "operation": "greater", "right": 2000000000 },
    { "left": "RSI", "operation": "in_range", "right": [25, 35] },
    { "left": "close", "operation": "greater", "right": "SMA200" }
  ],
  "sortBy": "Value.Traded",
  "maxResults": 200
}
```

```json
{ "mode": "snapshot", "symbols": ["NASDAQ:AAPL", "KRX:005930", "BINANCE:BTCUSDT", "FX:EURUSD"], "columns": ["name", "close", "change", "volume", "market_cap_basic", "currency", "type"] }
```

## Presets

Presets are ordinary scanner filters plus a sort; the exact definition used is written to the `SUMMARY` record. Thresholds are in the market's own currency. All stock presets require `type = stock`, `is_primary = true`, `active_symbol = true`.

| Preset | Filters | Sort | Markets |
|---|---|---|---|
| `large-cap-gainers` | typespecs has common; market_cap_basic > 10,000,000,000; change > 0 | change desc | stock markets |
| `large-cap-losers` | typespecs has common; market_cap_basic > 10,000,000,000; change < 0 | change asc | stock markets |
| `oversold-rsi` | average_volume_10d_calc > 100,000; RSI < 30 | RSI asc | stock markets |
| `high-dividend` | dividends_yield_current > 4; market_cap_basic > 1,000,000,000 | dividends_yield_current desc | stock markets |
| `52w-high` | average_volume_10d_calc > 100,000; close egreater price_52_week_high (column comparison) | market_cap_basic desc | stock markets |
| `most-active` | base filters only | Value.Traded desc | stock markets |
| `crypto-top-volume` | 24h_vol_cmc nempty | 24h_vol_cmc desc | `coin` |

Each preset adds its key columns to the output (for example `RSI`, `RSI7`, `average_volume_10d_calc` for `oversold-rsi`; `base_currency`, `market_cap_calc`, `24h_vol_cmc`, `circulating_supply`, `crypto_total_rank` for `crypto-top-volume`).

## Columns

The scanner's `metainfo` catalog lists 3,786 fields for `america` and other stock markets, about 3,300 for `crypto` and `coin`, 3,167 for `forex` and `cfd`, 469 for `futures` and 275 for `bond`; 124 names are common to all. Frequently used names, all verified against the catalog:

- Descriptive: `name`, `description`, `logoid`, `exchange`, `type` (stock, fund, dr, structured; spot, swap, futures; forex; bond), `typespecs` (common, etf, reit, preferred ...), `subtype`, `currency`, `country`, `sector`, `industry`, `market`, `submarket`, `is_primary`, `active_symbol`, `earnings_release_date`, `earnings_release_next_date`.
- Price and volume: `close`, `open`, `high`, `low`, `change`, `change_abs`, `gap`, `volume`, `Value.Traded`, `relative_volume_10d_calc`, `average_volume_10d_calc`, `average_volume_30d_calc`, `average_volume_90d_calc`, `VWAP`, `premarket_change`, `postmarket_change`, `price_52_week_high`, `price_52_week_low`, `High.All`, `Low.All`, `High.1M`, `Low.1M`, `High.3M`, `Low.3M`, `High.6M`, `Low.6M`.
- Performance and volatility: `Perf.W`, `Perf.1M`, `Perf.3M`, `Perf.6M`, `Perf.YTD`, `Perf.Y`, `Perf.3Y`, `Perf.5Y`, `Perf.10Y`, `Perf.All`, `Volatility.D`, `Volatility.W`, `Volatility.M`, `beta_1_year`, `change|1W`, `change|1M`.
- Technicals and ratings: `RSI`, `RSI7`, `Stoch.K`, `Stoch.D`, `Stoch.RSI.K`, `CCI20`, `ADX`, `AO`, `Mom`, `MACD.macd`, `MACD.signal`, `W.R`, `UO`, `BBPower`, `ATR`, `ROC`, `SMA10` ... `SMA200`, `EMA20` ... `EMA200`, `HullMA9`, `VWMA`, `BB.upper`, `BB.lower`, `P.SAR`, `Aroon.Up`, `Aroon.Down`, `Ichimoku.BLine`, `Pivot.M.Classic.R1`, `Recommend.All`, `Recommend.MA`, `Recommend.Other`, `Recommend.All|1W`, `Candle.Doji`, `Candle.Hammer`, `Candle.Engulfing.Bullish`.
- Fundamentals (stock markets): `market_cap_basic`, `enterprise_value_fq`, `enterprise_value_ebitda_ttm`, `price_earnings_ttm`, `price_book_fq`, `price_sales_current`, `earnings_per_share_basic_ttm`, `earnings_per_share_fq`, `earnings_per_share_forecast_next_fq`, `total_revenue`, `net_income`, `ebitda`, `gross_margin`, `operating_margin`, `net_margin`, `return_on_equity`, `return_on_assets`, `debt_to_equity`, `current_ratio`, `quick_ratio`, `total_debt`, `total_assets`, `number_of_employees`, `number_of_shareholders`, `total_shares_outstanding_fundamental`, `float_shares_outstanding`, `dividends_yield`, `dividends_yield_current`, `dividends_per_share_fq`, `dividend_payout_ratio_ttm`, `price_target_1y`, `recommendation_mark`, `recommendation_total`.
- Crypto (`crypto`, `coin`): `base_currency`, `base_currency_desc`, `market_cap_calc`, `24h_vol_cmc`, `24h_vol_change_cmc`, `circulating_supply`, `crypto_total_rank`, `crypto_common_categories`.
- Bonds and futures: `coupon`, `maturity_date`, `expiration`.

Timeframe variants use a pipe suffix (`RSI|1W`, `change|1M`, `Recommend.All|1W`). The full list for any market: run mode `fields`.

## Output

Screener and snapshot rows (default columns, abridged):

```json
{
  "symbol": "NASDAQ:NVDA",
  "exchange": "NASDAQ",
  "name": "NVDA",
  "market": "america",
  "close": 229.28,
  "change": -0.5207,
  "change_abs": -1.2,
  "volume": 84645275,
  "market_cap_basic": 5525647970581,
  "price_earnings_ttm": 45.1,
  "earnings_per_share_basic_ttm": 5.08,
  "dividends_yield": 0.0174,
  "sector": "Electronic Technology",
  "industry": "Semiconductors",
  "Recommend.All": 0.2667,
  "RSI": 52.96,
  "SMA50": 221.4,
  "SMA200": 196.8,
  "Perf.W": 1.9,
  "Perf.1M": 4.2,
  "Perf.YTD": 61.3,
  "Volatility.D": 2.41,
  "relative_volume_10d_calc": 0.78,
  "type": "stock",
  "description": "NVIDIA Corporation",
  "currency": "USD",
  "average_volume_10d_calc": 108400000,
  "float_shares_outstanding": 23400000000,
  "beta_1_year": 2.1,
  "asOf": "2026-10-11T05:12:40.118Z"
}
```

Fields rows (mode `fields`):

```json
{ "market": "america", "field": "sector", "type": "text", "values": ["Health Technology", "Commercial Services", "..."], "valueCount": 21, "sampleValue": "Electronic Technology", "sampleSymbol": "NASDAQ:NVDA", "verified": true, "source": "metainfo", "asOf": "2026-10-11T05:12:40.118Z" }
```

The key-value store record `SUMMARY` holds the request actually sent (columns, combined filters, sort, preset definition), the scanner's `totalCount` of matching symbols, request and page counts, missing snapshot symbols, columns that were null in every row, notes and the stop reason.

## Pricing

| Event | Price |
|---|---|
| Run start | $0.002 |
| Screener row | $0.0004 |
| Snapshot row | $0.001 |

Examples: a 500-row screen costs $0.002 + 500 x $0.0004 = **$0.20**; the 6,110 primary-listed United States stocks cost $2.45; everything the `america` scanner lists (20,328 rows) costs $8.13; a 100-ticker snapshot costs $0.10; the field catalog costs $0.002. The start fee is charged after the scanner has accepted the request, so a rejected filter costs nothing.

## Limits

- One request per second to the scanner, 500 rows per request: 20,000 rows take about 40 seconds plus retries. HTTP 429 and 5xx are retried with backoff.
- Unknown column names return `null` and unknown filter fields match nothing, rather than an error (listed in `SUMMARY.notes`); unsupported operations and type mismatches return the scanner's 400 message and fail the run without a charge.
- Monetary fields are in the market's currency (`currency` column); market cap thresholds in presets are therefore in won for `korea`, yen for `japan` and so on.
- Values are the scanner's delayed or end-of-day data for the last session; `asOf` is the fetch time, not the quote time.
- `global` has no field catalog; fields mode there uses the one-row probe.
- The Actor reads the public endpoint without authentication and sends no cookies.

## Local test

`npm test` runs the Actor against the live scanner: eight markets (america, korea, japan, germany, coin, crypto, forex, futures), five presets, custom filters with a column-to-column comparison and a `filter2` OR group, a 20-ticker mixed-exchange snapshot, the field catalog for america with its verification scan and the probe fallback for global, an unknown column and an unknown filter field, and six invalid inputs (two of them rejected by the scanner itself) that must fail with exit code 91 and no rows.
