"""Pholio analysis sandbox SDK.

Generated analysis code imports this package as:

```python
import pholio_sdk as pholio
```

The SDK fetches Pholio portfolio and market data through authenticated sandbox
API calls, then writes a compact JSON result for the agent tool UI.
"""

import json
import os
from pathlib import Path
from typing import Any, Literal, NotRequired, TypedDict
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OUTPUT_PATH = Path("/workspace/output.json")
DEFAULT_TIMEOUT_SECONDS = 20


class SectorAllocation(TypedDict):
    """Portfolio allocation for one sector."""

    sector: str
    valueUSD: float
    pct: float


def _json_default(value: Any) -> Any:
    """Normalize common analysis scalar objects and reject unknown objects."""

    if hasattr(value, "item") and callable(value.item):
        return value.item()
    if hasattr(value, "isoformat") and callable(value.isoformat):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


class PortfolioSummary(TypedDict):
    """High-level portfolio totals in USD."""

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


class Position(TypedDict):
    """Open position with current pricing and unrealized P&L."""

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


class PortfolioDashboard(TypedDict):
    """Portfolio dashboard payload."""

    summary: PortfolioSummary
    positions: list[Position]


class Quote(TypedDict):
    """Latest quote snapshot."""

    ticker: str
    price: float
    previousClose: float
    change: float
    changePct: float
    asOf: str


class Candle(TypedDict):
    """Daily OHLCV candle."""

    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    adjustedClose: NotRequired[float]


class Fundamentals(TypedDict):
    """Compact company fundamentals snapshot."""

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


class NewsArticle(TypedDict):
    """Recent company news article."""

    id: str
    ticker: str
    headline: str
    summary: NotRequired[str]
    url: str
    source: str
    publishedAt: str
    sentiment: NotRequired[Literal["positive", "negative", "neutral"]]


class MetricGridItem(TypedDict):
    """One displayed metric in a metric grid artifact."""

    label: str
    value: str | int | float
    unit: NotRequired[str]
    tone: NotRequired[Literal["default", "positive", "negative", "warning"]]


class MetricGridArtifact(TypedDict):
    """Metric-card artifact rendered as a compact grid."""

    type: Literal["metric_grid"]
    id: str
    title: str
    caption: NotRequired[str]
    items: list[MetricGridItem]


class LineChartSeries(TypedDict):
    """One line series definition for a line chart artifact."""

    key: str
    label: str


class LineChartArtifact(TypedDict):
    """Line chart artifact for compact time-series analysis.

    `xKey` and every `series[].key` must be simple identifiers: letters,
    numbers, and underscores only, starting with a letter or underscore.
    """

    type: Literal["line_chart"]
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]


class AreaChartArtifact(TypedDict):
    """Area chart artifact for filled or stacked time-series analysis."""

    type: Literal["area_chart"]
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]
    stacked: NotRequired[bool]


class BarChartArtifact(TypedDict):
    """Bar chart artifact for category or period comparisons."""

    type: Literal["bar_chart"]
    id: str
    title: str
    caption: NotRequired[str]
    xKey: str
    series: list[LineChartSeries]
    data: list[dict[str, str | int | float | None]]


class DonutSegment(TypedDict):
    """One segment in a donut chart artifact."""

    label: str
    value: int | float


class DonutChartArtifact(TypedDict):
    """Donut chart artifact for composition snapshots."""

    type: Literal["donut_chart"]
    id: str
    title: str
    caption: NotRequired[str]
    segments: list[DonutSegment]


class TableColumn(TypedDict):
    """One table column definition."""

    key: str
    label: str


class TableArtifact(TypedDict):
    """Small table artifact for compact comparison output.

    `columns[].key` must be a simple identifier: letters, numbers, and
    underscores only, starting with a letter or underscore.
    """

    type: Literal["table"]
    id: str
    title: str
    caption: NotRequired[str]
    columns: list[TableColumn]
    rows: list[dict[str, str | int | float | None]]


class TimelineEvent(TypedDict):
    """One event in an event timeline artifact."""

    date: str
    title: str
    description: NotRequired[str]
    tone: NotRequired[Literal["default", "positive", "negative", "warning"]]
    url: NotRequired[str]


class EventTimelineArtifact(TypedDict):
    """Timeline artifact for dated events, catalysts, or analysis steps."""

    type: Literal["event_timeline"]
    id: str
    title: str
    caption: NotRequired[str]
    events: list[TimelineEvent]


class CalloutArtifact(TypedDict):
    """Callout artifact for warnings, assumptions, or compact conclusions."""

    type: Literal["callout"]
    id: str
    title: str
    body: str
    tone: NotRequired[Literal["default", "positive", "negative", "warning"]]


AnalysisArtifact = (
    MetricGridArtifact
    | LineChartArtifact
    | AreaChartArtifact
    | BarChartArtifact
    | DonutChartArtifact
    | TableArtifact
    | EventTimelineArtifact
    | CalloutArtifact
)


def _get_ticker_key(ticker: Any) -> str:
    return str(ticker).upper()


def _api_base_url() -> str:
    value = os.environ.get("PHOLIO_API_BASE_URL")
    if not value:
        raise RuntimeError("PHOLIO_API_BASE_URL is not configured")
    return value.rstrip("/")


def _api_token() -> str:
    value = os.environ.get("PHOLIO_API_TOKEN")
    if not value:
        raise RuntimeError("PHOLIO_API_TOKEN is not configured")
    return value


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    query = urlencode({key: value for key, value in (params or {}).items() if value is not None})
    url = f"{_api_base_url()}{path}"
    if query:
        url = f"{url}?{query}"

    request = Request(url, headers={
        "Authorization": f"Bearer {_api_token()}",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; Pholio-SDK/1.0)",
    })

    try:
        with urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Pholio API request failed with HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Pholio API request failed: {exc.reason}") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Pholio API returned invalid JSON") from exc

    if not payload.get("ok"):
        raise RuntimeError(f"Pholio API error: {payload.get('error', 'unknown error')}")
    return payload.get("data")


class Input:
    """Compatibility namespace for older generated code.

    New analysis code should fetch data through `pholio.portfolio`,
    `pholio.market`, and `pholio.news` instead of reading preloaded input.
    """

    def load(self) -> dict[str, Any]:
        """Return an empty compatibility payload.

        The sandbox no longer receives a preloaded `/workspace/input.json`.
        Use the network-backed SDK namespaces for data access.
        """

        return {
            "run": self.metadata(),
            "data": {},
        }

    def metadata(self) -> dict[str, Any]:
        """Return empty run metadata for compatibility."""

        return {}

    def available_tickers(self) -> list[str]:
        """Return no preloaded tickers for compatibility."""

        return []


class Output:
    """Output namespace for returning analysis results."""

    def write(self, summary: str, result: Any, artifacts: list[AnalysisArtifact] | None = None) -> None:
        """Write the successful analysis output.

        Parameters:
            summary: One short non-empty sentence describing what was done.
            result: Compact JSON-serializable analysis result. Prefer a dict
                with metrics, warnings, and data gaps. Do not return raw
                candles, full news lists, plots, large tables, NaN, or Infinity.
            artifacts: Optional UI artifacts such as metric grids, line charts,
                or tables. Keep payloads compact and downsample chart data.
        """

        if not isinstance(summary, str) or not summary.strip():
            raise ValueError("summary must be a non-empty string")
        payload = {
            "summary": summary.strip(),
            "result": result,
        }
        if artifacts is not None:
            payload["artifacts"] = artifacts
        OUTPUT_PATH.write_text(json.dumps(payload, default=_json_default, ensure_ascii=False, allow_nan=False))

    def fail(self, summary: str, details: Any = None) -> None:
        """Write an expected data-gap result without raising an exception.

        Use this only for expected limitations. Let unexpected Python or API
        failures raise normally so the tool can surface the error.
        """

        self.write(summary, {"error": details or summary})


class Portfolio:
    """Portfolio namespace for user-scoped holdings and P&L data."""

    def dashboard(self) -> PortfolioDashboard:
        """Fetch the portfolio dashboard with summary and open positions."""

        return _get("/api/sandbox/portfolio/dashboard")

    def summary(self) -> PortfolioSummary | None:
        """Fetch and return the portfolio summary, or `None` if unavailable."""

        dashboard = self.dashboard()
        return dashboard.get("summary") if dashboard else None

    def positions(self) -> list[Position]:
        """Fetch and return open portfolio positions."""

        dashboard = self.dashboard()
        return dashboard.get("positions", []) if dashboard else []

    def position(self, ticker: str) -> Position | None:
        """Return one open position by ticker, case-insensitive."""

        symbol = _get_ticker_key(ticker)
        for position in self.positions():
            if _get_ticker_key(position.get("ticker")) == symbol:
                return position
        return None


class Market:
    """Market namespace for quote, candle, and fundamentals data."""

    def quote(self, ticker: str) -> Quote:
        """Fetch the latest quote snapshot for a ticker."""

        return _get("/api/sandbox/market/quote", {"ticker": _get_ticker_key(ticker)})

    def candles(self, ticker: str, from_: str | None = None, to: str | None = None, **kwargs: Any) -> list[Candle]:
        """Fetch daily OHLCV candles for a ticker and date range.

        Parameters:
            ticker: Stock symbol such as `"NVDA"`, case-insensitive.
            from_: Start date in `YYYY-MM-DD` format.
            to: End date in `YYYY-MM-DD` format.

        Notes:
            `from_date`, `from`, and `to_date` keyword aliases are accepted
            for compatibility, but new code should use `from_` and `to`.
        """

        from_value = from_ or kwargs.get("from_date") or kwargs.get("from")
        to_value = to or kwargs.get("to_date")
        if not from_value or not to_value:
            raise ValueError("candles requires from_ and to dates in YYYY-MM-DD format")
        return _get("/api/sandbox/market/candles", {
            "ticker": _get_ticker_key(ticker),
            "from": from_value,
            "to": to_value,
        })

    def fundamentals(self, ticker: str) -> Fundamentals:
        """Fetch compact fundamentals for a ticker."""

        return _get("/api/sandbox/market/fundamentals", {"ticker": _get_ticker_key(ticker)})


class News:
    """News namespace for recent ticker-specific articles."""

    def recent(self, ticker: str, days: int = 7) -> list[NewsArticle]:
        """Fetch recent news articles for a ticker.

        Parameters:
            ticker: Stock symbol such as `"NVDA"`, case-insensitive.
            days: Lookback window in days.
        """

        return _get("/api/sandbox/market/news", {
            "ticker": _get_ticker_key(ticker),
            "days": days,
        })


class Utils:
    """Small utility helpers for common analysis code."""

    def closes(self, candles: list[Candle] | list[dict[str, Any]]) -> list[float]:
        """Extract numeric close prices from candle dictionaries."""

        return [float(c["close"]) for c in candles if c.get("close") is not None]

    def returns(self, values: list[float]) -> list[float]:
        """Compute simple period returns from a price series."""

        result = []
        for prev, cur in zip(values[:-1], values[1:]):
            if prev:
                result.append((cur - prev) / prev)
        return result


class PholioSDK:
    """Root SDK object for the analysis environment."""

    input: Input
    output: Output
    portfolio: Portfolio
    market: Market
    news: News
    utils: Utils

    def __init__(self) -> None:
        self.input = Input()
        self.output = Output()
        self.portfolio = Portfolio()
        self.market = Market()
        self.news = News()
        self.utils = Utils()


sdk = PholioSDK()
input = sdk.input
output = sdk.output
portfolio = sdk.portfolio
market = sdk.market
news = sdk.news
utils = sdk.utils


# Backward-compatible shims for existing generated code during prototyping.
def load_input() -> dict[str, Any]:
    """Return an empty compatibility payload.

    Prefer `pholio.portfolio`, `pholio.market`, and `pholio.news` for new
    analysis code.
    """

    return input.load()


def write_output(value: Any) -> None:
    """Write an analysis result using the old single-argument style."""

    if isinstance(value, dict) and "summary" in value and "result" in value:
        output.write(value["summary"], value["result"])
    else:
        output.write("Analysis completed.", value)


def closes(candles: list[Candle] | list[dict[str, Any]]) -> list[float]:
    """Extract numeric close prices from candle dictionaries."""

    return utils.closes(candles)
