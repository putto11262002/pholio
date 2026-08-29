# Pholio Python SDK Reference

Generated analysis code imports the SDK as:

```python
import pholio_sdk as pholio
```

`pholio` exposes the namespace instances documented below.

## Type Aliases

- `AnalysisArtifact = MetricGridArtifact | LineChartArtifact | AreaChartArtifact | BarChartArtifact | DonutChartArtifact | TableArtifact | EventTimelineArtifact | CalloutArtifact`

## Namespaces

### `pholio.input`

Compatibility namespace for older generated code.

#### `pholio.input.load() -> dict[str, Any]`

Return an empty compatibility payload.

The sandbox no longer receives a preloaded `/workspace/input.json`.
Use the network-backed SDK namespaces for data access.

Returns: `dict[str, Any]`

#### `pholio.input.metadata() -> dict[str, Any]`

Return empty run metadata for compatibility.

Returns: `dict[str, Any]`

#### `pholio.input.available_tickers() -> list[str]`

Return no preloaded tickers for compatibility.

Returns: `list[str]`

### `pholio.output`

Output namespace for returning analysis results.

#### `pholio.output.write(summary: str, result: Any, artifacts: list[AnalysisArtifact] | None = None) -> None`

Write the successful analysis output.


Parameters:
- `summary`: One short non-empty sentence describing what was done.
- `result`: Compact JSON-serializable analysis result. Prefer a dict
  with metrics, warnings, and data gaps. Do not return raw
  candles, full news lists, plots, large tables, NaN, or Infinity.
- `artifacts`: Optional UI artifacts such as metric grids, line charts,
  or tables. Keep payloads compact and downsample chart data.

Returns: `None`

#### `pholio.output.fail(summary: str, details: Any = None) -> None`

Write an expected data-gap result without raising an exception.

Use this only for expected limitations. Let unexpected Python or API
failures raise normally so the tool can surface the error.

Returns: `None`

### `pholio.portfolio`

Portfolio namespace for user-scoped holdings and P&L data.

#### `pholio.portfolio.dashboard() -> PortfolioDashboard`

Fetch the portfolio dashboard with summary and open positions.

Returns: `PortfolioDashboard`

#### `pholio.portfolio.summary() -> PortfolioSummary | None`

Fetch and return the portfolio summary, or `None` if unavailable.

Returns: `PortfolioSummary | None`

#### `pholio.portfolio.positions() -> list[Position]`

Fetch and return open portfolio positions.

Returns: `list[Position]`

#### `pholio.portfolio.position(ticker: str) -> Position | None`

Return one open position by ticker, case-insensitive.

Returns: `Position | None`

### `pholio.market`

Market namespace for quote, candle, and fundamentals data.

#### `pholio.market.quote(ticker: str) -> Quote`

Fetch the latest quote snapshot for a ticker.

Returns: `Quote`

#### `pholio.market.candles(ticker: str, from_: str | None = None, to: str | None = None, **kwargs: Any) -> list[Candle]`

Fetch daily OHLCV candles for a ticker and date range.


Parameters:
- `ticker`: Stock symbol such as `"NVDA"`, case-insensitive.
- `from_`: Start date in `YYYY-MM-DD` format.
- `to`: End date in `YYYY-MM-DD` format.


Notes:
`from_date`, `from`, and `to_date` keyword aliases are accepted
for compatibility, but new code should use `from_` and `to`.

Returns: `list[Candle]`

#### `pholio.market.fundamentals(ticker: str) -> Fundamentals`

Fetch compact fundamentals for a ticker.

Returns: `Fundamentals`

### `pholio.news`

News namespace for recent ticker-specific articles.

#### `pholio.news.recent(ticker: str, days: int = 7) -> list[NewsArticle]`

Fetch recent news articles for a ticker.


Parameters:
- `ticker`: Stock symbol such as `"NVDA"`, case-insensitive.
- `days`: Lookback window in days.

Returns: `list[NewsArticle]`

### `pholio.utils`

Small utility helpers for common analysis code.

#### `pholio.utils.closes(candles: list[Candle] | list[dict[str, Any]]) -> list[float]`

Extract numeric close prices from candle dictionaries.

Returns: `list[float]`

#### `pholio.utils.returns(values: list[float]) -> list[float]`

Compute simple period returns from a price series.

Returns: `list[float]`

## Return Shapes

### `SectorAllocation`

Portfolio allocation for one sector.

```python
class SectorAllocation(TypedDict):
    sector: str
    valueUSD: float
    pct: float
```

### `PortfolioSummary`

High-level portfolio totals in USD.

```python
class PortfolioSummary(TypedDict):
    totalValueUSD: float
    totalCostUSD: float
    unrealizedPnLUSD: float
    unrealizedPnLPct: float
    realizedPnLUSD: float
    sectorAllocation: list[SectorAllocation]
    positionCount: int
    asOf: str
    fxRate: float
    fxAsOf: str
```

### `Position`

Open position with current pricing and unrealized P&L.

```python
class Position(TypedDict):
    ticker: str
    netQuantity: float
    totalBought: float
    totalSold: float
    totalCost: float
    totalProceeds: float
    tradeCount: int
    name: str
    sector: NotRequired[str]
    logoUrl: NotRequired[str]
    currentPriceUSD: float
    priceAsOf: str
    avgCost: float
    valueUSD: float
    unrealizedPnLUSD: float
    unrealizedPnLPct: float
```

### `PortfolioDashboard`

Portfolio dashboard payload.

```python
class PortfolioDashboard(TypedDict):
    summary: PortfolioSummary
    positions: list[Position]
```

### `Quote`

Latest quote snapshot.

```python
class Quote(TypedDict):
    ticker: str
    price: float
    previousClose: float
    change: float
    changePct: float
    asOf: str
```

### `Candle`

Daily OHLCV candle.

```python
class Candle(TypedDict):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    adjustedClose: NotRequired[float]
```

### `Fundamentals`

Compact company fundamentals snapshot.

```python
class Fundamentals(TypedDict):
    ticker: str
    asOf: str
    marketCap: NotRequired[float]
    peRatio: NotRequired[float]
    eps: NotRequired[float]
    revenue: NotRequired[float]
    week52High: NotRequired[float]
    week52Low: NotRequired[float]
    dividendYield: NotRequired[float]
    beta: NotRequired[float]
```

### `NewsArticle`

Recent company news article.

```python
class NewsArticle(TypedDict):
    id: str
    ticker: str
    headline: str
    summary: NotRequired[str]
    url: str
    source: str
    publishedAt: str
    sentiment: NotRequired[Literal['positive', 'negative', 'neutral']]
```

### `MetricGridItem`

One displayed metric in a metric grid artifact.

```python
class MetricGridItem(TypedDict):
    label: str
    value: str | int | float
    unit: NotRequired[str]
    tone: NotRequired[Literal['default', 'positive', 'negative', 'warning']]
```

### `MetricGridArtifact`

Metric-card artifact rendered as a compact grid.

```python
class MetricGridArtifact(TypedDict):
    type: Literal['metric_grid']
    id: str
    title: str
    caption: NotRequired[str]
    items: list[MetricGridItem]
```

### `LineChartSeries`

One line series definition for a line chart artifact.

```python
class LineChartSeries(TypedDict):
    key: str
    label: str
```

### `LineChartArtifact`

Line chart artifact for compact time-series analysis.

`xKey` and every `series[].key` must be simple identifiers: letters,
numbers, and underscores only, starting with a letter or underscore.

```python
class LineChartArtifact(TypedDict):
    type: Literal['line_chart']
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]
```

### `AreaChartArtifact`

Area chart artifact for filled or stacked time-series analysis.

```python
class AreaChartArtifact(TypedDict):
    type: Literal['area_chart']
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]
    stacked: NotRequired[bool]
```

### `BarChartArtifact`

Bar chart artifact for category or period comparisons.

```python
class BarChartArtifact(TypedDict):
    type: Literal['bar_chart']
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]
```

### `DonutSegment`

One segment in a donut chart artifact.

```python
class DonutSegment(TypedDict):
    label: str
    value: int | float
```

### `DonutChartArtifact`

Donut chart artifact for composition snapshots.

```python
class DonutChartArtifact(TypedDict):
    type: Literal['donut_chart']
    id: str
    title: str
    caption: NotRequired[str]
    segments: list[DonutSegment]
```

### `TableColumn`

One table column definition.

```python
class TableColumn(TypedDict):
    key: str
    label: str
```

### `TableArtifact`

Small table artifact for compact comparison output.

`columns[].key` must be a simple identifier: letters, numbers, and
underscores only, starting with a letter or underscore.

```python
class TableArtifact(TypedDict):
    type: Literal['table']
    id: str
    title: str
    caption: NotRequired[str]
    columns: list[TableColumn]
    rows: list[dict[str, str | int | float | None]]
```

### `TimelineEvent`

One event in an event timeline artifact.

```python
class TimelineEvent(TypedDict):
    date: str
    title: str
    description: NotRequired[str]
    tone: NotRequired[Literal['default', 'positive', 'negative', 'warning']]
    url: NotRequired[str]
```

### `EventTimelineArtifact`

Timeline artifact for dated events, catalysts, or analysis steps.

```python
class EventTimelineArtifact(TypedDict):
    type: Literal['event_timeline']
    id: str
    title: str
    caption: NotRequired[str]
    events: list[TimelineEvent]
```

### `CalloutArtifact`

Callout artifact for warnings, assumptions, or compact conclusions.

```python
class CalloutArtifact(TypedDict):
    type: Literal['callout']
    id: str
    title: str
    body: str
    tone: NotRequired[Literal['default', 'positive', 'negative', 'warning']]
```
