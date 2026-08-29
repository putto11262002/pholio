# Agent design

Last updated 2026-05-07.

## Current direction

The chat agent is a general-use analyst agent inside the Pholio product domain. It is not a general assistant. Its job is to help a retail investor understand their portfolio, stocks they care about, and market context well enough to think better.

For v0, the agent is a proof of concept for how far an AI analyst can go with user portfolio data, market data, research context, and bounded computation. We are testing what it can do, where it fails, and what data/tools it needs before splitting work into specialized subagents.

The agent should be read-only. The LLM should plan, call tools, and explain results. It should not inspect long candle arrays directly, perform arithmetic from memory, recommend trades, place orders, or mutate portfolio data.

The initial product strategy is **portfolio-aware news + fundamentals + trend**. This is not day trading, not pure technical analysis, and not "AI predicts winners." The goal is to turn vibe trading into structured thinking.

## Product goal

The agent should help users answer questions like:

- What is happening in my portfolio?
- Why did my portfolio move today or this week?
- Which holdings are driving gains/losses?
- Am I concentrated in one stock, sector, factor, or currency exposure?
- What happened to a specific stock recently?
- How does this stock look technically, fundamentally, and in recent news?
- What should I pay attention to before earnings or after a major move?
- How do two holdings compare?
- What data is missing before I can make a better judgment?

It should not be a stock picker or robo-advisor. It can surface facts, risks, tradeoffs, scenarios, and things worth investigating. It should avoid "buy/sell/hold" recommendations.

## Decision-Support Framework

Default analysis should follow this medium-term framework:

1. What happened?
   - Price move, news, earnings, analyst change, market/sector move.

2. Is it material?
   - Did fundamentals, guidance, valuation, narrative, or risk actually change?

3. Is the market already reacting?
   - Price move, volume if available, trend, drawdown, SMA 50/200, RSI, volatility.

4. How does it affect my portfolio?
   - Position weight, P&L impact, concentration, sector exposure, FX exposure.

5. What should I watch next?
   - Upcoming earnings, unresolved news, key metric, data gap, or follow-up source.

This framework is the first "strategy" of the agent: medium-term monitoring and structured analysis for retail investors who currently trade from vibes, headlines, or incomplete context.

## Initial Data Requirements

Minimum useful data:

- User trades, holdings, cost basis, realized/unrealized P&L.
- Current quote and previous close.
- 6M-1Y daily candles.
- Company profile and sector/industry.
- Fundamentals: market cap, P/E, EPS, revenue, beta, dividend yield, 52-week high/low.
- Recent news for 7-30 days.
- Earnings date and past earnings.
- Analyst target and recommendation trends.
- USD/THB FX.

Later data:

- SEC filings.
- Earnings transcripts.
- Sector and benchmark comparison.
- Insider/institutional ownership.
- Options/implied volatility.
- Better news source ranking and citation quality.

## Current Data and Tool Inventory

### Data Vendors In Use

- Finnhub
  - Quotes.
  - Daily candles.
  - Company news.
  - Company profile.
  - Fundamentals.
  - Earnings calendar.
  - Price targets.
  - Recommendation trends.

- FMP
  - Daily historical EOD fallback for candles.
  - Planned broader role for fundamentals/transcripts/ratings later.

- Frankfurter
  - Current USD/THB FX rate.

### Data Stored Locally

- Trades.
- Company profiles.
- Daily market bars.
- Daily fundamentals snapshot.
- News articles.
- Earnings events.
- FX bars schema exists, but historical FX fetch/use is not fully wired.

### Internal Server Capabilities Already Available

These exist under `src/market/api.server.ts` or trade modules:

- `getQuote`
- `getQuotes`
- `getDailyBars`
- `getFXRate`
- `getNews`
- `getNextEarnings`
- `getPastEarnings`
- `getCompanyProfile`
- `searchCompanyProfiles`
- `getFundamentals`
- `getPriceTarget`
- `getRecommendationTrends`
- `getLatestRecommendation`
- `getPortfolioDashboard`
- `getPositionDetail`
- `getPositionPriceHistoryFn`

### Agent Tools Exposed Today

- `portfolio_get_summary`
- `portfolio_get_position_detail`
- `portfolio_get_allocation`
- `portfolio_get_risk_snapshot`
- `market_get_quote`
- `market_get_company_info`
- `news_get_recent`
- `market_get_fundamentals`
- `market_get_earnings`
- `market_get_price_target`
- `market_get_recommendation_trends`
- `market_get_fx_rate`
- `market_get_price_history_summary`
- `analysis_run_code`

### Sandbox Bridge Exposed Today

- `GET /api/sandbox/portfolio/dashboard`
- `GET /api/sandbox/market/quote`
- `GET /api/sandbox/market/candles`
- `GET /api/sandbox/market/news`
- `GET /api/sandbox/market/fundamentals`

## Data/Tool Gap Map

### High-Value Tools To Expose Next

These use existing internal capabilities and are now exposed as compact tools:

- `get_price_history`
  - Implemented as `market_get_price_history_summary` for compact model context.

- `market_get_earnings`
  - Needed for earnings prep/post-earnings context.

- `market_get_price_target`
  - Needed for analyst-context summaries, with careful caveats.

- `market_get_recommendation_trends`
  - Needed for "has analyst sentiment changed?" questions.

- `market_get_fx_rate`
  - Needed for Thai investor context and USD/THB impact.

- `portfolio_get_position_detail`
  - Needed for per-holding analysis with trade history and user cost basis.

Still pending as first-class deterministic analytics tools:

- `analytics_calculate_technical_indicators`
- `analytics_calculate_returns`
- `analytics_compare_tickers`
- `analytics_calculate_portfolio_impact`
- `analytics_calculate_correlation`

### Analytics Missing As First-Class Tools

Currently common indicators live only as helpers inside the sandbox SDK. We should add deterministic app-side analytics:

- Returns over selected periods.
- SMA/EMA.
- RSI.
- MACD later.
- Volatility.
- Max drawdown.
- Distance from 52-week high/low.
- Portfolio concentration.
- Portfolio risk snapshot.
- Correlation/comparison.

These should become pure functions under `src/analytics/` and then be exposed as tools. Code execution remains for custom combinations and exploratory analysis.

### Data Missing For Stronger Stock Analysis

- SEC filing metadata and selected 10-K/10-Q sections.
- Earnings transcripts or transcript summaries.
- Better news source ranking and article body access.
- Sector/benchmark index comparison.
- Historical FX rates for FX impact over time.
- Corporate actions: dividends, splits.
- Growth/profitability metrics beyond simple P/E/EPS/revenue.
- Estimate revisions and richer analyst data.
- Insider/institutional ownership later.

### Data Quality Caveats

- Company profile is DB-first and can be missing for unseeded tickers unless `ensureCompanyProfile` has run.
- Fundamentals currently persist a limited field set; `beta` is not persisted in the DB snapshot.
- News has headline/summary/source/url but no robust source-quality scoring.
- Historical FX schema exists, but the app mostly uses current FX.
- Free-tier vendor limits can affect agent reliability during testing.

## Tool vs SDK Exposure Model

Use two exposure paths:

1. Agent tools
   - Compact, text-friendly, quick facts for LLM reasoning.
   - Good for summaries, routing, choosing next steps, and answering simple questions.
   - Should return small payloads with clear labels, timestamps, and caveats.
   - Examples: quote, company info, portfolio summary, latest news headlines, earnings date, price target.

2. Sandbox SDK
   - Large numeric data and computation-oriented access.
   - Good for candles, time-series, multi-ticker comparison, portfolio-wide calculations, and custom analysis.
   - Should avoid putting large arrays into model context.
   - Generated code computes compact metrics, then returns `output.json` for the LLM to explain.

Rule of thumb:

```txt
Small facts / text context      -> agent tool
Large arrays / heavy math       -> sandbox SDK + code execution
Common repeatable calculations  -> deterministic analytics tools
Custom exploratory calculations -> sandbox SDK + code execution
```

The same internal server modules can power both paths. The difference is interface shape, not business logic.

## Proposed Agent Tool Groups

### AI SDK Tool-Calling Notes

AI SDK v6 gives us several useful controls for a larger tool surface:

- `activeTools`
  - Limit which tools are available for a given generation step.
  - Useful for loading only portfolio tools, market tools, research tools, or code execution depending on the task.

- `prepareStep`
  - Change model settings, system prompt, active tools, tool choice, or messages between tool-loop steps.
  - Useful for simple routing: first step classifies/plans, later steps expose only relevant tools.

- `toolChoice`
  - Can be `"auto"`, `"none"`, `"required"`, or a specific tool.
  - Useful when a workflow must fetch portfolio first or must execute an analysis tool before answering.

- `stopWhen`
  - Controls loop length.
  - Keep strict limits; tool-heavy agents can become slow and expensive.

- Tool lifecycle callbacks
  - `experimental_onToolCallStart` and `experimental_onToolCallFinish` can log tool timing, input, output/error, and duration.
  - Useful for observability before deeper audit persistence.

- Tool approval
  - Useful for dangerous tools. We likely do not need approval for read-only market/portfolio tools, but code execution may later need approval or policy checks for expensive/ambiguous tasks.

- Dynamic tools
  - Useful when schemas are not known at compile time, especially MCP.
  - Prefer static, typed tools for Pholio core tools. Use dynamic tools only for external/MCP-style expansion.

Best-practice implication: do not expose every possible tool on every step. Keep the active tool set small and contextual. AI SDK's own prompt guidance recommends keeping tool count low and parameter schemas simple where possible.

### Tool Loading Strategy

Use a staged active-tool strategy rather than one giant tool bag:

1. Core step
   - Active tools: compact portfolio/market/news tools plus code execution.
   - Goal: answer common questions and decide if deeper analysis is needed.

2. Portfolio task
   - Active tools: portfolio tools, FX, position detail, analytics/code execution.
   - Goal: allocation, P&L, concentration, scenario impact.

3. Stock task
   - Active tools: quote, company, fundamentals, news, earnings, price target, recommendations, code execution.
   - Goal: single-stock deep dive.

4. Technical task
   - Active tools: price history/analytics/code execution.
   - Goal: compute trend, indicators, drawdown, volatility.

5. Research task later
   - Active tools: search/open/filings/transcripts.
   - Goal: cited external context.

6. Browser task later
   - Active tools: browser/search/open page only.
   - Goal: source inspection or UI testing, not routine computation.

Do not start with a full autonomous router unless needed. A simple heuristic router can inspect the user query and choose active tool groups before `streamText`. Later, `prepareStep` can refine active tools across steps.

### Tool Definition Guidelines

For every tool:

- Use a short, verb-noun name.
- Make the description say when to use it and when not to use it.
- Keep input schemas shallow.
- Prefer enums/ranges over free-form strings where possible.
- Use `.describe(...)` on every input field.
- Return compact, labeled objects with `asOf`, `source`, and caveats where possible.
- Do not return large arrays to the model unless the purpose is explicitly inspection.
- Use date strings in schemas, not JavaScript `Date` inputs.
- Prefer nullable fields over deeply optional shapes when strict schema compatibility matters.
- Avoid overlapping tools unless their routing is clear.
- Add display metadata for every visible chat tool.

For Pholio specifically:

- Agent tools should be compact facts and summaries for reasoning.
- Sandbox SDK should expose larger data for generated code.
- Common calculations should graduate into deterministic analytics tools.
- Research/browser tools should require citations.
- Write/mutation tools remain out of v0.

### Portfolio Tools

Purpose: answer user-specific portfolio questions with compact summaries.

- `portfolio_get_summary`
  - Current portfolio summary and open positions.
  - Already exposed.

- `portfolio_get_position_detail`
  - Per-ticker user position, cost basis, P&L, trade history summary.
  - Should expose compact trade summary, not every raw detail unless requested.

- `portfolio_get_allocation`
  - Ticker/sector/currency allocation.
  - Could be derived from `portfolio_get_summary`, but useful as a focused tool.

- `portfolio_get_risk_snapshot`
  - Concentration, top holdings, sector exposure, FX exposure, major P&L drivers.
  - Already exposed as a compact portfolio-derived snapshot.

### Market Data Tools

Purpose: compact external market facts.

- `market_get_quote`
  - Already exposed.

- `market_get_company_info`
  - Already exposed; should remain compact.

- `market_get_fundamentals`
  - Separate explicit tool for valuation/fundamental questions.

- `market_get_price_target`
  - Analyst target context with caveats.

- `market_get_recommendation_trends`
  - Analyst recommendation trend context.

- `market_get_earnings`
  - Next earnings and recent past earnings.

- `market_get_fx_rate`
  - Current USD/THB or other pair.

- `market_get_price_history_summary`
  - Compact price-history summary over a selected range.
  - Returns bar count, first/latest close, period return, high/low, and average volume.
  - Raw candle arrays remain in the sandbox/code-execution path.

### News and Research Tools

Purpose: compact research context with sources.

- `news_get_recent`
  - Already exposed; should include headline, source, summary, URL, published date.

- `research_search_web`
  - Later. For current facts that are not in vendors.

- `research_open_page`
  - Later. For source inspection/summarization.

- `research_search_filings`
  - Later. SEC filing metadata and selected sections.

- `research_get_transcript_summary`
  - Later. Earnings call transcript context.

### Analytics Tools

Purpose: deterministic calculations that should not require generated code every time.

- `analytics_calculate_technical_indicators`
  - SMA/EMA/RSI/MACD/drawdown/volatility over selected range.

- `analytics_calculate_returns`
  - Period returns for ticker(s) or portfolio.

- `analytics_compare_tickers`
  - Return/volatility/drawdown/fundamental comparison.

- `analytics_calculate_portfolio_impact`
  - Scenario math: ticker move -> portfolio impact.

- `analytics_calculate_correlation`
  - Multi-holding correlation later.

### Code Execution Tool

Purpose: flexible custom numerical analysis that combines datasets/tools in ways not yet captured by deterministic analytics tools.

- `analysis_run_code`
  - Already exposed.
  - Should be used for custom calculations, multi-step numerical workflows, and exploratory analysis.
  - Should not be used for unrelated coding tasks, web scraping, package installs, or long-running training.

## Proposed Sandbox SDK Namespaces

The SDK should feel like a small local data-analysis library for Pholio. It should expose large data and helper functions to generated code without bloating LLM context.

### `pholio.output`

- `write(result)`
  - Write schema-shaped JSON to `PHOLIO_OUTPUT_PATH` (falling back to `/workspace/output.json` outside managed runs).

### `pholio.portfolio`

- `dashboard()`
  - Fetch current portfolio dashboard through the sandbox API.

- `positions()`
  - Return current positions.

- `position(ticker)`
  - Return one holding if available.

### `pholio.market`

- `quote(ticker)`
  - Fetch quote through the sandbox API.

- `candles(ticker, from_, to)`
  - Fetch candle array through the sandbox API.

- `fundamentals(ticker)`
  - Fetch fundamentals through the sandbox API.

- `news(ticker)`
  - Fetch recent news through the sandbox API.

These call `/api/sandbox/*` with short-lived user-scoped tokens.

### `pholio.utils`

Keep SDK utilities intentionally small. The SDK should expose data and output contracts, not become a strategy library.

- `closes(candles)`
- `returns(values)`

Most analysis should be written directly by the generated Python code using installed Python libraries, or handled by deterministic app-side analytics tools when the workflow becomes common.

### SDK Design Rules

- SDK functions must be read-only.
- SDK functions should never expose secrets.
- SDK functions should never directly access the database.
- SDK functions should call the sandbox bridge with scoped tokens.
- SDK outputs should be JSON-serializable.
- SDK should prefer compact data access over broad, ambiguous power functions.
- Workflow intelligence belongs in playbooks/skills and prompts, not in the SDK.

## Sandbox Python Libraries

The sandbox should include a small, reliable analysis stack so generated code can perform flexible analysis without us prebuilding every indicator into the SDK.

Recommended base:

- `pandas`
- `numpy`
- `scipy`
- `statsmodels` later if needed
- `ta` or `pandas-ta-classic` for technical indicators

Avoid at first:

- TA-Lib, because native dependencies can create build/deploy friction.
- Heavy ML libraries unless we intentionally support model training later.
- Packages that encourage web scraping, broker automation, or external network access.

Example generated-code direction:

```python
import numpy as np
import pandas as pd
import pholio_sdk as pholio

bars = pholio.market.candles("NVDA", from_="2025-01-01", to="2025-04-15")
df = pd.DataFrame(bars)

close = df["close"]
sma50 = close.rolling(50).mean().iloc[-1]
delta = close.diff()
gain = delta.clip(lower=0).rolling(14).mean()
loss = (-delta.clip(upper=0)).rolling(14).mean()
rsi14 = 100 - (100 / (1 + (gain / loss)))
result = {
    "metrics": {
        "sma50": float(sma50) if not np.isnan(sma50) else None,
        "rsi14": float(rsi14.iloc[-1]) if not np.isnan(rsi14.iloc[-1]) else None,
    },
    "warnings": [],
    "dataGaps": [],
}
pholio.output.write("Computed NVDA SMA and RSI from fetched candles.", result)
```

The agent should write code for the specific question, not blindly call a large SDK function that hides the reasoning.

## Skills and Playbooks

The durable workflow knowledge should live in playbooks/skills, not in a large SDK. Skills follow a progressive-disclosure shape: the base prompt lists concise skill metadata, the model calls a skill tool to load the `SKILL.md` entry point when needed, and referenced files are loaded separately only when the loaded skill asks for them.

Current first-pass implementation: skill tools are mounted in the chat agent. Runtime skill reads are R2-only through the shared `STORAGE_BUCKET` binding. If a manifest or file is missing, the skill tool returns an explicit error instead of falling back to bundled content.

Skill content is shaped like Agent Skills and lives under repo-root `skills/`:

```txt
skills/
  manifest.json
  code-analysis-env/
    SKILL.md
    references/sdk.md
    manifest.json
```

The model-facing tools are:

- `skill_list`: list skill metadata and available reference files.
- `skill_load`: load only the `SKILL.md` entry point for one skill.
- `skill_read_file`: load one referenced skill file by id or path.

Do not add `skill_execute_script` yet. Skill scripts should only be considered after sandbox policy and observability are stronger.

### Skill Registry and R2 Direction

The skill registry uses repo-root `skills/` as source and R2 as the runtime source of truth. There is no skill versioning for now. The active skill set is whatever is currently uploaded at `skills/manifest.json`.

Target R2 object layout inside the shared app storage bucket:

```txt
skills/
  manifest.json
  code-analysis-env/
    SKILL.md
    references/sdk.md
    manifest.json
```

Top-level manifest is only an index:

- skill name
- entry path
- per-skill manifest path

Per-skill manifests track detail:

- skill name
- title
- description
- entry file
- file list
- content hashes/checksums
- allowed tools

Updating a skill is intentionally simple: edit the skill source, generate manifests, and upload to the selected R2 bucket. Dev and production deployment use the same command path; only `--env` changes the target bucket.

```bash
pnpm skills:deploy --env=dev
pnpm skills:deploy --env=production
```

Current path:

1. Skill registry finalization:
   - move skill content into repo-root `skills/`
   - generate manifests from `skills/**`
   - keep `skill_load` and `skill_read_file` behavior unchanged
   - use R2 buckets `trademe-dev` for non-production and `trademe` for production
   - deploy skills locally, separate from app deployment
2. Sandbox SDK package:
   - move Python SDK into repo-root `sandbox-sdk/`
   - manage it as a uv project
   - generate `skills/code-analysis-env/references/sdk.md` from SDK docstrings or structured metadata
   - install/copy the SDK into the sandbox image

Longer-term path:

- cache active manifests in the Worker
- consider versioning once skill content stabilizes
- record loaded skill metadata per chat run for debugging
- fail explicitly if a requested manifest or skill file is missing

R2 buckets created for this direction:

- `trademe-dev`
- `trademe`

Current Worker binding:

- `STORAGE_BUCKET` -> `trademe-dev` for local testing in this branch

Skill artifacts live under the `skills/` prefix in this shared app bucket. There is no Worker fallback for skills. Before local testing, generate manifests and upload the reviewed skill content:

```bash
pnpm skills:deploy --env=dev
pnpm dev
```

Production skill deployment is separate from app deployment and is currently local-only:

```bash
pnpm skills:deploy --env=production
```

Skill deployment commands always regenerate manifests from repo-root `skills/**` immediately before upload. This prevents release drift between source files and R2 manifests.

Do not wire skill upload into Vite dev/build. The Worker reads skills from R2 at runtime, so generating local manifests during Vite startup would not change what the agent sees. Local testing should explicitly run `pnpm skills:deploy --env=dev` when skill files change.

CI behavior:

- No skill-specific CI or GitHub deployment workflow for now.
- Skill deploys are deliberate local commands.

Do not configure public custom domains for skill artifacts until we explicitly decide that the artifacts are safe to expose. Default stance: skills are private and read by the Worker through an R2 binding.

Each playbook should define:

- Question it answers.
- When to use it.
- Required data.
- Preferred agent tools.
- When to use code execution.
- Expected output structure.
- Caveats and prohibited claims.
- Data gaps to report.

This keeps the architecture clean:

```txt
Agent prompt       = scope + routing
Agent tools        = compact facts
Sandbox SDK        = data access + output contract
Python libraries   = flexible computation
Playbooks/skills   = analysis workflows
```

## Information Required For Full Analysis

This is the target information set for high-quality portfolio-aware stock analysis. We do not need all of it for v0, but the agent design should make clear what is missing and why.

### User Portfolio Information

- Current holdings by ticker.
- Quantity, average cost, and cost basis.
- Trade history by ticker.
- Realized and unrealized P&L.
- Portfolio weights by ticker.
- Sector/industry allocation.
- Currency exposure, especially USD/THB.
- Cash balance later, if tracked.
- User watchlist later.
- User thesis/notes later, if we add them.
- User time horizon/risk preference later, if explicitly collected.

### Price and Market Information

- Current quote.
- Previous close and daily move.
- 6M-1Y daily OHLCV candles for normal analysis.
- Longer 3Y-5Y history for long-term context later.
- Volume and abnormal volume.
- 52-week high/low.
- Benchmark/sector index comparison.
- Market-wide context: S&P 500, Nasdaq, relevant sector ETF.
- USD/THB current and historical FX.

### Fundamental Information

- Market cap.
- Revenue.
- EPS.
- P/E and forward P/E later.
- Revenue growth.
- EPS growth.
- Gross/operating/net margin later.
- Free cash flow later.
- Debt/cash/balance-sheet strength later.
- Dividend yield, dividends, splits.
- Valuation ranges or peer comparison later.
- Company description, sector, industry, country, exchange.

### Events and Analyst Context

- Upcoming earnings date.
- Past earnings actual vs estimate.
- Guidance changes later.
- Analyst price targets.
- Recommendation trends.
- Estimate revisions later.
- Major corporate actions.
- Product launches, regulatory events, lawsuits, or macro events when available.

### News and Research Information

- Recent ticker-specific news, 7-30 days.
- News source and URL.
- News summaries.
- Source quality/reliability ranking.
- Article body or extract later, where licensing permits.
- SEC filings metadata.
- 10-K/10-Q sections: business, risk factors, MD&A.
- 8-K material event filings.
- Earnings call transcripts or transcript summaries.
- Cited web sources for research answers.

### Technical and Statistical Information

- Period returns.
- SMA/EMA 20/50/100/200.
- RSI.
- MACD later.
- Volatility.
- Max drawdown.
- Distance from 52-week high/low.
- Correlation between holdings.
- Beta or benchmark sensitivity.
- Support/resistance-style levels later, framed carefully.

### Portfolio Impact Information

- Position weight.
- Contribution to total P&L.
- Contribution to daily/weekly portfolio move.
- Concentration flags.
- Sector overlap.
- FX contribution to P&L.
- Scenario impact: "if ticker moves +/- X%, portfolio changes by Y."

### Data Quality Information

- Source/vendor for each data point.
- Timestamp/as-of date.
- Freshness/staleness.
- Missing fields.
- Conflicting values across vendors.
- Confidence level for extracted/researched information.
- Licensing/display restrictions where relevant.

### Why This Matters

The agent should distinguish between:

- analysis it can do confidently with current data,
- analysis it can approximate with caveats,
- analysis it should defer because required information is missing.

When data is missing, the agent should say what is missing and why it matters instead of filling the gap with speculation.

## Capability Layers

The agent needs five capability layers:

1. Portfolio context
   - User holdings, cost basis, P&L, allocation, concentration, realized/unrealized gains, FX exposure, trade history.

2. Market data
   - Quotes, OHLCV/candles, fundamentals, analyst signals, earnings dates, price targets, recommendations, FX rates.

3. Computation and analytics
   - Returns, volatility, drawdown, moving averages, RSI/MACD-style indicators, correlation, portfolio risk snapshots, comparisons, scenario math.

4. Research context
   - Recent news, company descriptions, filings/transcripts later, cited web sources, source quality ranking.

5. Orchestration
   - The general agent decides what is needed, calls deterministic tools first, uses code execution for custom analysis, and later hands off to specialized subagents for deeper tasks.

The principle is:

```txt
tools/code = numbers and retrieval
LLM        = planning, synthesis, explanation, caveats
```

Do not send large candle arrays to the LLM for reasoning. Compute first, then explain compact results.

## Agent Shape

Start with one general agent because v0 is a capability probe. Over time, split repeatable workflows into specialized subagents with narrower prompts and tool access:

- Portfolio Analyst: allocation, P&L, concentration, risk, FX impact.
- Stock Analyst: single-stock deep dives across fundamentals, technicals, news, events.
- Research Analyst: web/news/filing retrieval with citations and source grading.
- Technical Analyst: candle/indicator computation and chart-style summaries.
- Data QA Analyst: detects stale/missing/conflicting data and asks for clarification.

The general chat agent remains the front door. Subagents should be invoked only when a task is specific enough to benefit from tighter instructions and tool limits.

## Later Workflow Layer

Slash commands, proactive agents, scheduled jobs, and background monitoring are later features. They should not shape the current v0 implementation too much, but the design should leave room for them.

Candidate later workflows:

- `/portfolio-review`: run a full portfolio allocation/risk review.
- `/stock-deep-dive TICKER`: run the single-stock playbook.
- `/news-impact TICKER`: summarize recent material news and portfolio impact.
- `/earnings-prep TICKER`: prepare before an upcoming earnings report.
- `/post-earnings TICKER`: review what changed after earnings.
- `/technical-check TICKER`: run technical trend/momentum analysis.
- `/compare A B`: compare two stocks.

Candidate proactive/background agents:

- Portfolio Analysis Agent: scheduled portfolio review and risk/concentration drift.
- Market Survey Agent: scans market/sector/news context relevant to user holdings.
- Watchlist Agent: monitors user watchlist for news, earnings, large moves, and stale theses.
- Chore Agent: detects missing data, stale prices, failed imports, and other cleanup tasks.
- Suggestion Agent: surfaces "things worth checking" without issuing buy/sell/hold instructions.

These should run through explicit schedules, user opt-in, and notification controls. For now, keep v0 focused on the interactive general analyst.

## Playbooks

Start with playbooks as documented workflows. Later, promote the strongest playbooks into subagents, skills, or structured tools.

### Portfolio Allocation Review

Purpose: help the user understand portfolio shape and risk.

- Allocation by ticker and sector.
- Largest holdings and concentration.
- Biggest unrealized/realized P&L drivers.
- FX exposure.
- Position sizing flags.
- Data gaps.

### Single Stock Deep Dive

Purpose: explain one stock through fundamentals, news, trend, and portfolio impact.

- Business snapshot.
- Current quote and recent move.
- Key fundamentals/valuation.
- Recent news and events.
- Technical trend.
- Upcoming earnings or catalysts.
- Portfolio impact if user owns it.
- Data gaps and what to watch next.

### News Impact Review

Purpose: turn a headline into structured context.

- What happened.
- Source quality.
- Affected tickers.
- Materiality assessment.
- Price reaction.
- Portfolio impact.
- Follow-up sources.

### Earnings Prep

Purpose: help user know what to watch before earnings.

- Earnings date.
- Recent price trend.
- Analyst expectations if available.
- Recent company/sector news.
- Key metrics to watch.
- Portfolio exposure.

### Post-Earnings Review

Purpose: summarize what changed after an earnings report.

- Actual vs estimate.
- Guidance and management commentary if available.
- Market reaction.
- Analyst/news reaction.
- Portfolio impact.
- Changed assumptions and data gaps.

### Technical Check

Purpose: provide trend/momentum context without pretending to predict.

- Return over selected period.
- SMA/EMA context.
- RSI/momentum.
- Drawdown.
- Volatility.
- Distance from 52-week high/low.
- Avoid overclaiming signal strength.

### Compare Two Stocks

Purpose: compare roles and context, not pick a winner.

- Recent performance.
- Fundamentals/valuation.
- Trend and volatility.
- News/events.
- Portfolio role and overlap.
- Data gaps.

The split is:

```txt
LLM                  planner + explainer
AI SDK tools         capability boundary
Internal modules     portfolio, market DAL, analytics
Cloudflare Sandbox   bounded code execution for flexible analysis
Research/browser     cited external context, separate from computation
```

## Shipped primitive bridge

The same Worker exposes a thin sandbox bridge at `/api/sandbox/*`. These endpoints are intentionally small path-to-function mappings over existing internal modules:

- `GET /api/sandbox/portfolio/dashboard`
- `GET /api/sandbox/market/quote?ticker=NVDA`
- `GET /api/sandbox/market/candles?ticker=NVDA&from=2025-05-06&to=2026-05-06`
- `GET /api/sandbox/market/news?ticker=NVDA&days=7`
- `GET /api/sandbox/market/fundamentals?ticker=NVDA`

They use a short-lived `PHOLIO_API_TOKEN` bearer token minted by the Worker for the current user. This is a sandbox bridge, not a public product API.

## Code execution slice

`analysis_run_code` runs generated Python inside Cloudflare Sandbox. The sandbox image installs the local `pholio_sdk` package. Each conversation maps to one stable, normalized sandbox identity, while every tool call gets a unique `/workspace/runs/<uuid>` directory. The Worker writes that run's `run_analysis.py`, passes `PHOLIO_API_BASE_URL`, a short-lived `PHOLIO_API_TOKEN`, and `PHOLIO_OUTPUT_PATH`, then reads the run-local `output.json`.

Execution uses the Sandbox 1.0 preview process-handle model. Launches use argv rather than a shell string, remote process deadlines backstop bounded local output waits, and stdout/stderr are capped. A cancelled or locally timed-out wait sends `SIGKILL` and waits for the supervised process group to exit. The run directory is removed by a separately supervised `rm -rf --` process in all outcomes; cleanup failures are recorded as metadata and never replace the primary success or failure. If an upload or process launch outlives the foreground cancellation window, the chat Agent defers a continuation with its Durable Object context so the late operation is stopped and the run directory is removed again without delaying the user-visible cancellation. The conversation sandbox is allowed to sleep between calls and is not destroyed after each run.

Status: bounded lifecycle implemented on the Sandbox 1.0 preview. Known operational constraints:

- Local runs can fail if `PHOLIO_API_BASE_URL` does not point at an origin reachable from the sandbox container.
- Application-level analysis retries are disabled; lifecycle errors become safe typed tool failures for the model to handle.
- Logs intentionally contain only identifiers, timing, status, and typed error metadata. Generated code, task text, summaries, results, tokens, stdout, stderr, and raw error messages are excluded.
- The SDK is now packaged into the sandbox image, but its generated reference docs are still maintained manually.

The generated Python contract:

```python
import pholio_sdk as pholio

bars = pholio.market.candles("NVDA", from_="2025-01-01", to="2025-04-15")
pholio.output.write(
    "Computed 1-month trend metrics for NVDA.",
    {
        "ticker": "NVDA",
        "metrics": {},
        "warnings": [],
    },
)
```

The output contract is intentionally small:

```ts
type AnalysisOutput = {
  summary: string
  result: unknown
}
```

`summary` is used for the tool-call UI. `result` is free-form JSON for the agent to interpret and explain. The Worker validates that output is valid JSON, has this shape, and stays below the output-size limit.

### Generated analysis artifacts

The next UI layer should treat agent outputs as `answer + artifacts`, not only prose. Artifacts are structured, app-rendered UI payloads generated by tools. The LLM can mention artifact titles in its final response, but it does not choose layout or emit arbitrary frontend code.

Placement rule:

- Do not render artifacts inside the collapsed tool-call group.
- Extract artifacts from completed assistant tool parts.
- Render artifacts inline inside assistant text where the model places `[artifact:<id>]` markers.
- Use only artifact ids returned by tools.
- If the assistant forgets to place an artifact marker, render unreferenced artifacts as a fallback so artifacts are not lost.

First-pass artifact source:

- Start with `analysis_run_code`, because generated Python is already the flexible path for custom calculations, candle analysis, and portfolio math.
- Later, deterministic tools can return artifacts directly for common product views such as allocation, risk snapshot, quote cards, and news/source tables.

Output shape:

```ts
type AnalysisOutput = {
  summary: string
  result: unknown
  artifacts?: AnalysisArtifact[]
}

type ArtifactScalar = string | number | null

type AnalysisArtifact =
  | {
      type: "metric_grid"
      id: string
      title: string
      caption?: string
      items: Array<{
        label: string
        value: string | number
        unit?: string
        tone?: "default" | "positive" | "negative" | "warning"
      }>
    }
  | {
      type: "line_chart"
      id: string
      title: string
      caption?: string
      xKey: string
      series: Array<{ key: string; label: string }>
      data: Array<Record<string, ArtifactScalar>>
    }
  | {
      type: "area_chart"
      id: string
      title: string
      caption?: string
      xKey: string
      series: Array<{ key: string; label: string }>
      data: Array<Record<string, ArtifactScalar>>
      stacked?: boolean
    }
  | {
      type: "bar_chart"
      id: string
      title: string
      caption?: string
      xKey: string
      series: Array<{ key: string; label: string }>
      data: Array<Record<string, ArtifactScalar>>
    }
  | {
      type: "donut_chart"
      id: string
      title: string
      caption?: string
      segments: Array<{ label: string; value: number }>
    }
  | {
      type: "table"
      id: string
      title: string
      caption?: string
      columns: Array<{ key: string; label: string }>
      rows: Array<Record<string, ArtifactScalar>>
    }
  | {
      type: "event_timeline"
      id: string
      title: string
      caption?: string
      events: Array<{
        date: string
        title: string
        description?: string
        tone?: "default" | "positive" | "negative" | "warning"
        url?: string
      }>
    }
  | {
      type: "callout"
      id: string
      title: string
      body: string
      tone?: "default" | "positive" | "negative" | "warning"
    }
```

Artifact constraints:

- Keep artifacts deterministic and schema-rendered by Pholio components.
- Treat artifacts as display primitives: use them for shape and rendering, not as a fixed analysis workflow.
- Cap payload size and row/point counts. A first-pass cap of roughly 200 chart points per artifact is enough for chat.
- Use simple identifier keys for chart/table fields: letters, numbers, and underscores only, starting with a letter or underscore.
- Use ISO date strings such as `YYYY-MM-DD` for date/time chart rows. The UI formats recognized ISO dates; arbitrary category labels are displayed as provided.
- Keep model-generated labels short because artifacts render inside compact chat surfaces.
- Keep `summary` and `result` compact for model reasoning. Do not make the model repeat full artifact data.
- Large artifact data may later move to persisted artifact refs if tool-output context cost becomes a problem.
- Initial frontend renderers should use existing shadcn/Tailwind and the app's chart primitives where possible.
- Artifact demo route: `/dev/artifacts` renders every primitive with sample data for visual alignment before expanding prompt guidance.

The bundled SDK now exposes namespaced data accessors:

- `pholio.output.write(summary, result)`
- `pholio.output.fail(summary, details)`
- `pholio.portfolio.dashboard()`
- `pholio.portfolio.summary()`
- `pholio.portfolio.positions()`
- `pholio.portfolio.position(ticker)`
- `pholio.market.quote(ticker)`
- `pholio.market.candles(ticker, from_, to)`
- `pholio.market.fundamentals(ticker)`
- `pholio.news.recent(ticker)`
- `pholio.utils.closes(candles)`
- `pholio.utils.returns(values)`

Backward-compatible shims (`load_input`, `write_output`, `closes`) remain temporarily for prototyping.

## What remains

- Add broader sandbox SDK methods as more internal data endpoints exist.
- Add a persisted audit log for generated code, sandbox API requests, run id, output, errors, and latency.
- Add strict output schema validation for tables, metrics, charts, warnings, and citations.
- Add dedicated pure analytics modules under `src/analytics/` so common indicators do not need generated code.
- Add per-user/run quotas: timeout, max candle rows, max tickers, max output size, and max concurrent sandboxes.
- Add clearer regulatory guardrails in prompt and UI: information only, no order execution, no buy/sell instructions.
- Decide whether sandbox callback traffic should stay on the HTTP bridge or move to Cloudflare-native outbound handlers later.
