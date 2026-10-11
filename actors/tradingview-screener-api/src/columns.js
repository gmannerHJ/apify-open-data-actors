// Markets, column catalog, presets and filter operations for the TradingView scanner endpoint
// (POST https://scanner.tradingview.com/{market}/scan). Every market below answered HTTP 200 on 2026-10-11.

export const NON_STOCK_MARKETS = ['global', 'crypto', 'coin', 'forex', 'cfd', 'bond', 'futures'];

export const STOCK_MARKETS = [
    'america', 'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru', 'venezuela',
    'uk', 'germany', 'france', 'spain', 'italy', 'netherlands', 'belgium', 'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland', 'iceland', 'ireland', 'luxembourg', 'portugal', 'greece', 'cyprus',
    'poland', 'czech', 'hungary', 'slovakia', 'slovenia', 'croatia', 'serbia', 'romania', 'estonia', 'latvia', 'lithuania', 'russia', 'turkey',
    'israel', 'egypt', 'ksa', 'uae', 'qatar', 'bahrain', 'kuwait', 'nigeria', 'kenya', 'rsa', 'morocco', 'tunisia',
    'india', 'pakistan', 'bangladesh', 'srilanka', 'china', 'hongkong', 'taiwan', 'japan', 'korea', 'singapore', 'malaysia', 'thailand', 'indonesia', 'vietnam', 'philippines', 'australia', 'newzealand',
];

export const MARKETS = [...STOCK_MARKETS, ...NON_STOCK_MARKETS];

// Returned for every row when requested. Names are the scanner's own.
export const DEFAULT_COLUMNS = [
    'name', 'close', 'change', 'change_abs', 'volume', 'market_cap_basic', 'price_earnings_ttm', 'earnings_per_share_basic_ttm',
    'dividends_yield', 'sector', 'industry', 'Recommend.All', 'RSI', 'SMA50', 'SMA200', 'Perf.W', 'Perf.1M', 'Perf.YTD', 'Volatility.D',
    'relative_volume_10d_calc', 'exchange', 'type', 'description', 'currency', 'average_volume_10d_calc', 'float_shares_outstanding', 'beta_1_year',
];

// Columns the scanner returns although they are absent from its /metainfo field catalog.
export const EXTRA_COLUMNS = ['name', 'description', 'logoid', 'Value.Traded', 'base_currency', 'base_currency_desc'];

// Filter operations accepted by the scanner's filter array ({left, operation, right}).
export const OPERATIONS = [
    'equal', 'nequal', 'greater', 'egreater', 'less', 'eless',
    'in_range', 'not_in_range', 'in_range%', 'not_in_range%',
    'match', 'nmatch', 'has', 'has_none_of', 'empty', 'nempty',
    'crosses', 'crosses_above', 'crosses_below', 'above%', 'below%', 'in_day_range', 'not_in_day_range',
];

export const ARRAY_RIGHT_OPERATIONS = ['in_range', 'not_in_range', 'in_range%', 'not_in_range%', 'has', 'has_none_of', 'in_day_range', 'not_in_day_range'];
export const NO_RIGHT_OPERATIONS = ['empty', 'nempty'];

// Curated catalog, verified against the america /metainfo on 2026-10-11 (3,786 fields there; use mode "fields" for the full list).
export const KNOWN_COLUMNS = [
    // descriptive
    'name', 'description', 'logoid', 'exchange', 'type', 'typespecs', 'subtype', 'currency', 'country', 'sector', 'industry', 'market', 'submarket',
    'is_primary', 'active_symbol', 'update_mode', 'pricescale', 'minmov', 'fractional', 'minmove2', 'earnings_release_date', 'earnings_release_next_date',
    // price and volume
    'close', 'open', 'high', 'low', 'change', 'change_abs', 'gap', 'volume', 'Value.Traded', 'relative_volume_10d_calc', 'average_volume_10d_calc',
    'average_volume_30d_calc', 'average_volume_90d_calc', 'VWAP', 'premarket_change', 'postmarket_change', 'price_52_week_high', 'price_52_week_low',
    'High.All', 'Low.All', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.6M', 'Low.6M',
    // performance and volatility
    'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.3Y', 'Perf.5Y', 'Perf.10Y', 'Perf.All', 'Perf.1Y.MarketCap',
    'Volatility.D', 'Volatility.W', 'Volatility.M', 'beta_1_year', 'change|1W', 'change|1M',
    // technical indicators and ratings
    'RSI', 'RSI7', 'Stoch.K', 'Stoch.D', 'Stoch.RSI.K', 'CCI20', 'ADX', 'AO', 'Mom', 'MACD.macd', 'MACD.signal', 'W.R', 'UO', 'BBPower', 'ATR', 'ROC',
    'SMA10', 'SMA20', 'SMA50', 'SMA100', 'SMA200', 'EMA20', 'EMA50', 'EMA100', 'EMA200', 'HullMA9', 'VWMA', 'BB.upper', 'BB.lower', 'P.SAR',
    'Aroon.Up', 'Aroon.Down', 'DonchCh20.Upper', 'Ichimoku.BLine', 'Pivot.M.Classic.R1',
    'Recommend.All', 'Recommend.MA', 'Recommend.Other', 'Recommend.All|1W', 'Rec.Stoch.RSI', 'Rec.WR', 'Rec.BBPower', 'Rec.UO', 'Rec.Ichimoku', 'Rec.VWMA', 'Rec.HullMA9',
    'Candle.Doji', 'Candle.Hammer', 'Candle.Engulfing.Bullish',
    // fundamentals (stock markets)
    'market_cap_basic', 'enterprise_value_fq', 'enterprise_value_ebitda_ttm', 'price_earnings_ttm', 'price_book_fq', 'price_sales_current',
    'earnings_per_share_basic_ttm', 'earnings_per_share_fq', 'earnings_per_share_forecast_next_fq', 'total_revenue', 'net_income', 'ebitda',
    'gross_margin', 'operating_margin', 'net_margin', 'return_on_equity', 'return_on_assets', 'debt_to_equity', 'current_ratio', 'quick_ratio',
    'total_debt', 'total_assets', 'revenue_per_employee', 'number_of_employees', 'number_of_shareholders', 'total_shares_outstanding_fundamental',
    'float_shares_outstanding', 'dividends_yield', 'dividends_yield_current', 'dividends_per_share_fq', 'dps_common_stock_prim_issue_fy',
    'dividend_payout_ratio_ttm', 'price_target_1y', 'recommendation_mark', 'recommendation_total',
    // crypto (markets crypto and coin)
    'base_currency', 'base_currency_desc', 'market_cap_calc', '24h_vol_cmc', '24h_vol_change_cmc', 'circulating_supply', 'crypto_total_rank', 'crypto_common_categories',
    // bonds and futures
    'coupon', 'maturity_date', 'expiration',
];

const STOCK_BASE = [
    { left: 'type', operation: 'equal', right: 'stock' },
    { left: 'is_primary', operation: 'equal', right: true },
    { left: 'active_symbol', operation: 'equal', right: true },
];
const LIQUID = { left: 'average_volume_10d_calc', operation: 'greater', right: 100000 };

// Presets are plain scanner filters plus a sort; the definition used is written to the SUMMARY record.
export const PRESETS = {
    'large-cap-gainers': {
        title: 'Large-cap gainers',
        description: 'Primary-listed common stocks with market cap above 10 billion (in the market currency) and a positive day change, largest change first.',
        markets: 'stock',
        filters: [...STOCK_BASE, { left: 'typespecs', operation: 'has', right: ['common'] }, { left: 'market_cap_basic', operation: 'greater', right: 1e10 }, { left: 'change', operation: 'greater', right: 0 }],
        sort: { sortBy: 'change', sortOrder: 'desc' },
        columns: ['change', 'change_abs', 'market_cap_basic', 'volume', 'Value.Traded', 'sector'],
    },
    'large-cap-losers': {
        title: 'Large-cap losers',
        description: 'Same universe as large-cap-gainers with a negative day change, largest loss first.',
        markets: 'stock',
        filters: [...STOCK_BASE, { left: 'typespecs', operation: 'has', right: ['common'] }, { left: 'market_cap_basic', operation: 'greater', right: 1e10 }, { left: 'change', operation: 'less', right: 0 }],
        sort: { sortBy: 'change', sortOrder: 'asc' },
        columns: ['change', 'change_abs', 'market_cap_basic', 'volume', 'Value.Traded', 'sector'],
    },
    'oversold-rsi': {
        title: 'Oversold RSI',
        description: 'Primary-listed stocks with 14-day RSI below 30 and 10-day average volume above 100,000, lowest RSI first.',
        markets: 'stock',
        filters: [...STOCK_BASE, LIQUID, { left: 'RSI', operation: 'less', right: 30 }],
        sort: { sortBy: 'RSI', sortOrder: 'asc' },
        columns: ['RSI', 'RSI7', 'change', 'average_volume_10d_calc', 'market_cap_basic', 'Perf.1M'],
    },
    'high-dividend': {
        title: 'High dividend yield',
        description: 'Primary-listed stocks with a current dividend yield above 4 percent and market cap above 1 billion (market currency), highest yield first.',
        markets: 'stock',
        filters: [...STOCK_BASE, { left: 'dividends_yield_current', operation: 'greater', right: 4 }, { left: 'market_cap_basic', operation: 'greater', right: 1e9 }],
        sort: { sortBy: 'dividends_yield_current', sortOrder: 'desc' },
        columns: ['dividends_yield_current', 'dividends_yield', 'dividend_payout_ratio_ttm', 'dividends_per_share_fq', 'market_cap_basic', 'sector'],
    },
    '52w-high': {
        title: 'At 52-week high',
        description: 'Primary-listed stocks with 10-day average volume above 100,000 whose last close is at or above their 52-week high (column-to-column comparison), largest market cap first.',
        markets: 'stock',
        filters: [...STOCK_BASE, LIQUID, { left: 'close', operation: 'egreater', right: 'price_52_week_high' }],
        sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
        columns: ['price_52_week_high', 'price_52_week_low', 'Perf.YTD', 'Perf.Y', 'volume', 'market_cap_basic'],
    },
    'most-active': {
        title: 'Most active by traded value',
        description: 'Primary-listed stocks ordered by traded value (close x volume) of the last session.',
        markets: 'stock',
        filters: [...STOCK_BASE],
        sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
        columns: ['Value.Traded', 'volume', 'relative_volume_10d_calc', 'change', 'market_cap_basic'],
    },
    'crypto-top-volume': {
        title: 'Crypto coins by 24h volume',
        description: 'Aggregated coins (market "coin", CRYPTO:xxxUSD symbols) with a known 24-hour volume, largest volume first.',
        markets: ['coin'],
        defaultMarket: 'coin',
        filters: [{ left: '24h_vol_cmc', operation: 'nempty' }],
        sort: { sortBy: '24h_vol_cmc', sortOrder: 'desc' },
        columns: ['base_currency', 'base_currency_desc', 'close', 'change', 'market_cap_calc', '24h_vol_cmc', '24h_vol_change_cmc', 'circulating_supply', 'crypto_total_rank', 'Perf.W', 'RSI', 'crypto_common_categories'],
    },
};
