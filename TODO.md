# TODO

Local working backlog for the agent design in `docs/agent_design.md`.
Keep durable product/design decisions in the design doc; keep this file focused on remaining execution work.

## Current State

- Current branch has local commits:
  - `40acf8c`: inline research citations.
  - `9598aef`: citation marker hardening.
  - `research_search_web` and `research_read_page` are wired into the chat agent.
  - Search uses Tavily when `TAVILY_API_KEY` is configured.
  - Page read uses `fetch` plus Readability extraction.
  - Research citation numbers are assigned per assistant response by a shared tool registry.
  - Inline citation runs like `[1][2]` render as one favicon pill.
  - Citation pills show a hover card with favicon, title, source/domain, and snippet/excerpt.
  - Citation parsing skips inline code, fenced code blocks, existing markdown links, and invalid citation ids.
  - Missing favicons fall back to the source/domain first letter.
- Generated analysis artifacts first pass is implemented locally:
  - `analysis_run_code` accepts optional `artifacts`.
  - Frontend renders artifacts inline where the assistant places `[artifact:<id>]`, with fallback rendering for unreferenced artifacts.
  - Supported primitive artifact types: `metric_grid`, `table`, `line_chart`, `area_chart`, `bar_chart`, `donut_chart`, `event_timeline`, and `callout`.
  - The sandbox SDK supports `trademe.output.write(summary, result, artifacts=...)`.
  - The code-analysis skill and SDK reference document artifact output.
- Merged PR #52: analysis sandbox SDK hardening, SDK reference generation, skill docs refresh, native chat streaming path, and chat/tool lifecycle logging.
- `analysis_run_code` uses API-backed data access through the bundled Python SDK instead of preloaded sandbox input files.
- The sandbox SDK calls `/api/sandbox/*` with a short-lived API token tied to the thread owner user id.
- Code-analysis skill docs and generated SDK reference are uploaded to both storage buckets:
  - dev: `trademe-dev`
  - prod: `trademe`
- Chat streaming is back on native `result.toUIMessageStreamResponse<ChatMessage>()`.
- The usage/context-ring UI was removed for now because custom usage streaming caused post-tool hangs.
- Chat/model hardening currently includes:
  - total model timeout: 90s
  - step timeout: 45s
  - chunk timeout: 30s
  - `agent.chat.tool_start`, `agent.chat.tool_finish`, `agent.chat.step_finish`, `agent.chat.finish`, `agent.chat.error`, and `agent.chat.abort` logs.
- Local smoke tests passed:
  - code written to sandbox
  - Python executed successfully
  - `output.json` validated
  - tool result returned
  - final assistant response completed after reverting to native stream.
- SDK smoke findings:
  - namespace/method coverage passed in app testing.
  - `market.quote`, `market.candles`, `market.fundamentals`, `news.recent`, `portfolio.summary`, and `portfolio.positions` responded.
  - `utils.closes` and `utils.returns` behaved correctly on sample data.
- Current data-quality findings:
  - candle data can be stale relative to latest quote data; latest observed quote date was 2026-05-08 while one test candle range ended 2025-04-15.
  - `news.recent("NVDA", 7)` returned 820 items, which likely needs server-side limit/dedupe/date-filter verification.
  - fundamentals response currently has missing `revenue`, so valuation workflows must treat it as optional.
  - portfolio SDK works, but current test account has no positions.

## Next Items

1. Generated analysis artifacts testing and polish.
2. Research quality/source-control pass.
3. SDK testing and data-quality pass.
4. Sandbox hardening pass.
5. Tool-call UX and error presentation pass.
6. Usage/context observability redesign.
7. Deterministic analytics tools.
8. Skill/tool observability and evals.
9. Prompt/policy refinement after tool surface stabilizes.
10. Agent memory and user context design.
11. Browser tools as part of research hardening.
12. Signal factory and interaction-layer design.

## Signal Factory And Interaction Layer

- [x] Reframe the top of `docs/agent_design.md` around product thesis, operating model, user-facing primitives, and the first Opportunity / Risk Review workflow.
- [ ] Continue restructuring `docs/agent_design.md` around the signal factory model:
  - input streams
  - detection layer
  - playbooks
  - signal scoring
  - user-facing outputs
  - memory/feedback loop.
- Define first-class user-facing primitives:
  - signal card
  - watch item
  - alert
  - action plan
  - report
  - research packet
  - rebalance review.
- [x] Lock first-pass app-layer entities into `docs/agent_design.md`:
  - `Signal`
  - `Watch`
  - `Alert`
  - `ActionPlan`
  - `Thesis`
  - `ResearchPacket`
  - `Report`
- Design how each primitive relates to the user's portfolio, watchlist, and stated strategy.
- Define the first "Opportunity / Risk Review" workflow for user questions like "Is TSLA worth buying and when?"
- Decide what fields belong in a stable signal shape:
  - title
  - scope
  - why it matters
  - evidence
  - confidence
  - urgency
  - time horizon
  - portfolio impact
  - suggested user action
  - suggested alerts
  - data gaps
  - sources
  - review/expiry date.
- Keep signals framed as decision support, not trade execution or guaranteed prediction.

## Generated Analysis Artifacts

Direction:
- Treat agent outputs as `answer + artifacts`.
- Tool outputs may include structured artifacts, but rendering remains app-controlled through known components.
- The LLM places artifacts in the final answer with `[artifact:<id>]` markers.
- The LLM should not choose layout, placement, or generate arbitrary frontend UI.
- Render artifacts inline where valid `[artifact:<id>]` markers appear, not inside the collapsed tool group.
- If an artifact is not referenced, render it as fallback so it is not lost.

First pass:
- [x] Extend `analysis_run_code` output validation to accept optional `artifacts`.
- [x] Add frontend extraction from completed tool parts.
- [x] Render artifacts inline in assistant text from `[artifact:<id>]` markers.
- [x] Support a small schema set:
  - `metric_grid`
  - `table`
  - `line_chart`
  - `area_chart`
  - `bar_chart`
  - `donut_chart`
  - `event_timeline`
  - `callout`
- [x] Cap artifact payloads:
  - chart points
  - table rows
  - total output bytes.
- [x] Update Python SDK docs/skill guidance so generated code can emit artifacts intentionally.
- [x] Add prompt rule: if analysis output includes artifacts, place them with `[artifact:<id>]` markers and do not invent ids.
- [x] Generate SDK reference docs from Python `TypedDict` artifact shapes so enum values and fields are visible to the agent.
- [x] Upload updated code-analysis skill docs to dev and prod storage.
- [x] Add `/dev/artifacts` demo route using the same artifact components as chat.

Testing and polish:
- Manual chat test passed for generated metric grid and line chart.
- Test the expanded primitive set in chat after uploading the refreshed skill docs.
- Visually review `/dev/artifacts` and tune primitive layouts before treating the artifact contract as stable.
- Decide whether unreferenced artifact fallback should stay after text.
- Optimize artifact rendering; current chat rendering can lag when artifacts/charts are present.
- Revisit artifact placement semantics; inline artifacts currently render before some preceding text in cases where the streaming/render pipeline has not settled.
- Define cross-boundary artifact refs clearly: tool result ids, assistant text markers, frontend render map, and any future persisted artifact ids should not drift or collide.

Later:
- Add artifacts from deterministic tools such as allocation, risk snapshot, and price history summary.
- Persist large artifacts or artifact refs if tool output context becomes too large.
- Add richer chart controls and disclosure for generated data/code.

## Web Research Tools

First pass:
- [x] Add `research_search_web` for compact current web results.
- [x] Add `research_read_page` for deterministic readable text extraction from a known URL.
- [x] Keep web access outside `analysis_run_code`.
- [x] Use Tavily Search API for search when `TAVILY_API_KEY` is configured.
- [x] Use plain `fetch` plus deterministic cleanup for page reads.
- [x] Cap page-read output to avoid context pollution.
- [x] Add prompt rules requiring citations when research tools are used.
- [x] Add per-assistant-response citation numbering to research tool outputs.
- [x] Render inline citation pills from source favicons.
- [x] Add hover-card source list for inline citations.
- [x] Harden citation parser so inline code, fenced code blocks, existing markdown links, and invalid ids are not rewritten.
- [x] Add source/domain first-letter fallback when favicon is missing.
- [x] Add minimal tool-call UI labels:
  - searching web
  - reading page.

Later passes:
- Manual citation testing completed for:
  - multiple searches in one assistant turn
  - duplicate URLs across search/read calls
  - grouped citations like `[1][2]`
  - fallback when favicon is missing
  - inline code and fenced code citation escaping.
- Improve source hover-card polish if testing reveals layout issues.
- Add domain/source controls for filings, IR pages, and high-quality financial sources.
- Add provider fallback or swap if Tavily quality/cost is not good enough.
- Add optional browser-rendered reader for JS-heavy pages.
- Add extraction/summarization tool only after basic search/read is stable.
- Add source quality/ranking rules and UI hints.
- Keep cross-boundary source refs documented and tested: tool-assigned citation numbers, assistant text markers, frontend source registry, and hover-card rendering should stay per assistant message.
- Consider a dedicated filings/IR search tool instead of generic web search for SEC and investor-relations work.

## SDK Testing And Data Quality

- Add a repeatable SDK smoke-test script or prompt that exercises:
  - namespace imports
  - quote
  - candles
  - fundamentals
  - recent news
  - portfolio summary/positions
  - output writing.
- Add SDK/server tests for data shape and max payload size.
- Add date-window helper or docs so generated code defaults to recent candle windows instead of stale hard-coded ranges.
- Verify candle vendor recency and date range behavior.
- Verify `news.recent(days)` actually filters by date.
- Add server-side `limit` and dedupe for news if needed.
- Decide whether to populate `fundamentals.revenue` from another vendor field or document it as unavailable.
- Add one seeded/dev portfolio with positions so portfolio analysis can be tested end to end.

## Sandbox Hardening

- Investigate and upgrade the Cloudflare Sandbox / Agent DO infrastructure libraries:
  - current packages include `@cloudflare/sandbox@0.9.3`, `agents@0.12.3`, and `@cloudflare/ai-chat@0.6.2`.
  - confirm whether observed tool-call hangs relate to older Sandbox/Agent DO behavior.
  - migrate to the current recommended Cloudflare Sandbox/Agents SDK path if APIs have changed.
  - retest code execution startup, exec completion, tool result streaming, and UI completion after migration.
- Add static code screening for obvious unsafe or out-of-scope patterns:
  - `subprocess`
  - `os.system`
  - `socket`
  - arbitrary network clients such as `requests`, `urllib`, `http.client`
  - `pip` or package installation
  - direct environment inspection such as `os.environ`
  - sensitive filesystem reads.
- Return clear recoverable tool errors when generated code is rejected.
- Document that static screening is defense-in-depth, not the primary sandbox boundary.
- Normalize or reject `NaN`, `Infinity`, and unserializable values in `result`.
- Decide whether code execution timeout should stay at 15s or increase slightly for first-run cold starts.
- Split timeout/error labels more clearly:
  - sandbox startup
  - sandbox file write
  - Python execution
  - output read/validation.
- Improve user-safe error presentation in chat UI; avoid raw stack traces or overly internal details.
- Add persistent audit/log sink later:
  - run id
  - user id
  - task
  - generated code
  - execution metadata
  - output summary
  - error class/message.
- Keep DB schema changes for audit persistence isolated in their own PR.

## Tool Call UX

- Improve visible tool-call states:
  - fetching portfolio
  - fetching market data
  - running technical analysis
  - searching web
  - browsing source
  - completed/failed.
- Show concise tool summaries from `analysis_run_code.summary`.
- Consider richer cards for:
  - analysis result
  - sources/citations
  - code used
  - data gaps.
- Decide whether generated code should be shown by default or hidden behind disclosure.
- Add user-safe display for recoverable analysis errors.

## Usage And Context Observability

- Do not reintroduce custom live stream wrapping until the post-tool hang is fully understood.
- Keep backend usage persistence via `insertAiRun`.
- Rebuild context usage UI from persisted run metadata or a separate post-turn fetch instead of injecting usage into the live message stream.
- Later verify context display against real provider usage for multi-step tool runs.

## Agent Memory And User Context

- Design long-term memory as explicit product state, not hidden model memory.
- Track durable user context that can improve analysis:
  - user profile and investing context
  - stated goals, time horizon, risk preference, and constraints
  - strategy/thesis notes and whether they worked over time
  - watchlist and recurring interests
  - environment context such as current market regime, data freshness, known vendor gaps, and active data-source limitations
  - user preferences for depth, formatting, charts, citations, and risk framing.
- Define memory boundaries:
  - what the agent may remember automatically
  - what requires explicit user confirmation
  - what can be edited/deleted by the user
  - what should stay session-only.
- Add memory retrieval rules to the future system prompt only after storage, consent, and UI controls are designed.
- Keep this separate from trading advice; memory should improve context and continuity, not turn the agent into an autonomous decision maker.

## Deterministic Analytics Tools

- Add pure analytics functions under `src/analytics/`.
- Candidate functions:
  - returns
  - SMA/EMA
  - RSI
  - volatility
  - max drawdown
  - correlation
  - ticker comparison helpers.
- Candidate tools:
  - `analytics_calculate_technical_indicators`
  - `analytics_calculate_returns`
  - `analytics_calculate_drawdown`
  - `analytics_calculate_volatility`
  - `analytics_calculate_correlation`
  - `compare_positions`.
- Prefer deterministic analytics tools for common repeatable requests.
- Reserve code execution for custom or multi-step numerical analysis.

## Skill Registry And Skills

- Add skill registry observability:
  - `skill_list`
  - `skill_load`
  - `skill_read_file`
  - skill name, file path, content bytes, checksum, and status.
- Add skill selection/evaluation tests:
  - model loads `code-analysis-env` before `analysis_run_code` for candle/calculation prompts.
  - model does not load code-analysis skill for simple quote/news questions.
  - model reads `references/sdk.md` only when writing Python code.
- Decide Worker cache policy for R2 skill manifest/file reads.
- Keep `skill_execute_script` out of scope until sandbox policy, logging, and evals are stronger.

## Agent Prompt And Policy

- Redraft the system prompt around the full tool taxonomy once tool shape stabilizes.
- Scope the agent to stock, market, portfolio, and investment-analysis questions.
- Politely decline unrelated work.
- Define routing:
  - portfolio tools for user holdings
  - market-data tools for current/static data
  - analytics tools for common calculations
  - code execution for custom/multi-step numerical analysis
  - research/search/browser for external context requiring citations.
- Explicitly disallow:
  - buy/sell/hold instructions
  - trade execution
  - neural-net/model training unless explicitly supported later
  - open-ended compute tasks
  - unrelated coding/helpdesk tasks.

## Research And Browser Tools

- Decide whether web search belongs in v0 chat or post-v0.
- Add research tools separately from code execution.
- Candidate tools:
  - `research_search_web`
  - `research_open_page`
  - `search_company_filings`
  - `get_recent_market_context`
  - `get_cited_sources`.
- Require citations for web/research answers.
- Keep search/browser results out of sandbox unless explicitly needed.
- Do not let generated code perform arbitrary web scraping.
- Treat browser tools as part of web research hardening:
  - use them when fetch/readability cannot access or interpret a JS-heavy page
  - use them to verify source pages visually when needed
  - keep browser outputs cited and compact
  - avoid polluting model context with raw page dumps.
- Browser tools should be research/acquisition tools only.
- Disallow broker login, trade placement, user form submission, and paywall/access-control bypass.
