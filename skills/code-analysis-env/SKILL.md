---
name: code-analysis-env
description: Use for bounded Python analysis over stock, candle, portfolio, market, news, and fundamentals data.
---

# Code Analysis Environment

Use this skill when the user's stock, market, or portfolio question requires calculations that are awkward or lossy in normal text.

Inside `analysis_run_code`, generated Python runs in `/workspace` with:

```python
import pholio_sdk as pholio
```

The sandbox image installs `pholio_sdk`. The Worker writes `/workspace/run_analysis.py`, runs it, then reads `/workspace/output.json`.

The SDK fetches portfolio and market data over authenticated sandbox API calls. Fetch only the data needed for the calculation.

Good use cases:
- candle analysis
- returns
- volatility
- drawdown
- moving averages
- portfolio concentration
- multi-ticker numerical comparison

Available Python libraries:
- Python standard library
- numpy
- pandas
- scipy
- statsmodels
- scikit-learn

Rules:
- Only use code execution for stock, market, portfolio, or investment-analysis tasks.
- Fetch only the data needed for the question through the SDK.
- Do not inspect long candle arrays in text. Load them in code and compute compact metrics.
- Generated Python must import pholio_sdk as pholio.
- Read references/sdk.md before writing non-trivial Python against the SDK.
- Generated Python must finish by calling pholio.output.write(summary, result). Use the optional artifacts argument only when a compact rendered primitive would make the analysis clearer.
- The summary must be one short sentence describing what the code did for the tool UI.
- The result must be JSON-serializable and compact. Do not return raw candles, large tables, verbose logs, NaN, or Infinity.
- Artifacts must be compact and schema-shaped. Use display primitives, not bespoke finance widgets.
- Artifact `xKey`, `series[].key`, and `columns[].key` values must be simple identifiers: letters, numbers, and underscores only, starting with a letter or underscore.
- For date/time chart data, use ISO date strings like `YYYY-MM-DD`. The UI formats recognized ISO dates; arbitrary category labels are rendered as provided.
- Keep display labels short: metric labels, column labels, series labels, segment labels, and event titles should fit compact chat UI.
- Artifact validation tolerates a few harmless aliases (`name` or `metric` for metric labels, `name` for donut segment labels, `description` for callout body), but prefer the documented field names.
- If a calculated value is not finite, return `None` or a compact data gap instead of NaN/Infinity.
- In the final answer, place artifacts with `[artifact:<id>]` markers where they should render. Use only ids returned in the artifact payload.
- If data is missing, return a compact result with dataGaps rather than inventing values.
- Unexpected HTTP/API failures should fail normally so the tool can surface the error.
- Use pholio.output.fail(summary, details) only for expected data limitations.

Reference files:
- references/sdk.md: SDK API signatures, return shapes, and method behavior.

Prefer direct deterministic tools when they answer the question without custom computation.

Artifact primitives:
- `metric_grid`: compact KPI values.
- `table`: small row comparisons.
- `line_chart`: price, moving average, drawdown, or return time series.
- `area_chart`: filled or stacked time-series exposure.
- `bar_chart`: category, ranking, or period comparison.
- `donut_chart`: composition snapshot.
- `event_timeline`: dated events, catalysts, earnings, or trade history.
- `callout`: assumptions, warnings, data gaps, or compact conclusions.

Artifact shape example:

```python
pholio.output.write(
    "Computed trend metrics for NVDA.",
    {"ticker": "NVDA", "warnings": []},
    artifacts=[
        {
            "type": "metric_grid",
            "id": "nvda-metrics",
            "title": "NVDA key metrics",
            "items": [
                {"label": "Period return", "value": -3.2, "unit": "%", "tone": "negative"},
                {"label": "RSI", "value": 52.1},
            ],
        },
        {
            "type": "line_chart",
            "id": "nvda-close-sma",
            "title": "NVDA close and moving average",
            "xKey": "date",
            "series": [
                {"key": "close", "label": "Close"},
                {"key": "sma20", "label": "20D SMA"},
            ],
            "data": [
                {"date": "2026-01-02", "close": 120.5, "sma20": None},
                {"date": "2026-01-03", "close": 122.1, "sma20": 121.0},
            ],
        },
    ],
)
```
