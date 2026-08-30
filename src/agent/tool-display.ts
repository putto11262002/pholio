export type ToolDisplay = {
  label: string
  loadingMessage: string | ((input: Record<string, unknown>) => string)
  resultMessage: (output: unknown) => string
}

function safeInputString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function safeUiText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const text = value.trim()
  if (!text || /\bundefined\b/i.test(text)) return fallback
  return text
}

export function toolLabel(toolName: unknown): string {
  if (typeof toolName !== "string" || !toolName.trim()) return "Tool"
  return safeUiText(toolDisplayRegistry[toolName]?.label, "Tool")
}

export function toolLoadingMessage(toolName: unknown, input: unknown): string {
  if (typeof toolName !== "string" || !toolName.trim()) return "Running a tool…"
  const display = toolDisplayRegistry[toolName]
  if (!display) return "Running a tool…"
  if (typeof display.loadingMessage === "string") {
    return safeUiText(display.loadingMessage, "Running a tool…")
  }
  const safeInput = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {}
  try {
    return safeUiText(display.loadingMessage(safeInput), "Running a tool…")
  } catch {
    return "Running a tool…"
  }
}

export function isNormalizedToolFailure(output: unknown): output is { success: false; message: string } {
  return typeof output === "object"
    && output !== null
    && "success" in output
    && output.success === false
    && "message" in output
    && typeof output.message === "string"
}

export function toolResultMessage(display: ToolDisplay | undefined, output: unknown): string | null {
  if (isNormalizedToolFailure(output)) return output.message || "Tool failed"
  if (!display) return null
  try {
    return safeUiText(display.resultMessage(output), "Tool finished")
  } catch {
    return "Tool finished"
  }
}

type Portfolio = { summary: { positionCount: number; totalValueUSD: number }; positions: unknown[] }
type Allocation = { byTicker: unknown[]; bySector: unknown[] }
type RiskSnapshot = { positionCount: number; topPositionWeightPct: number; top3WeightPct: number }
type PositionDetail = { ticker: string; position: { quantity: number; unrealizedPnLPct: number } | null }
type Quote = { ticker: string; price: number; changePct: number }
type Company = { name: string; sector?: string }
type NewsItem = { headline: string }[]
type AnalysisResult = { success: boolean; durationMs?: number; summary?: string; phase?: string }
type Fundamentals = { ticker: string; peRatio?: number; marketCap?: number }
type Earnings = { ticker: string; next: { date: string | Date } | null; past: unknown[] }
type PriceTarget = { numberOfAnalysts?: number; targetMean?: number }
type Recommendation = { trends: unknown[] }
type FXRate = { from: string; to: string; rate: number }
type PriceHistorySummary = { ticker: string; range: string; periodReturnPct: number | null; barCount: number }
type SkillList = { found?: boolean; skills: unknown[] }
type SkillLoad = { found: boolean; name: string; title?: string; references?: unknown[] }
type SkillFile = { found: boolean; title?: string; path?: string }
type ResearchSearch = { results: unknown[] }
type ResearchPage = { title?: string | null; truncated?: boolean; charCount?: number }

export const toolDisplayRegistry: Partial<Record<string, ToolDisplay>> = {
  skill_list: {
    label: "Skills",
    loadingMessage: "Checking available skills…",
    resultMessage: (out) => {
      const o = out as SkillList
      return `${o.skills.length} skill${o.skills.length !== 1 ? "s" : ""} available`
    },
  },

  skill_load: {
    label: "Skill",
    loadingMessage: (input) => safeInputString(input, "name") ? `Loading ${safeInputString(input, "name")}…` : "Loading a skill…",
    resultMessage: (out) => {
      const o = out as SkillLoad
      if (!o.found) return "Skill not found"
      const refs = o.references?.length ? ` · ${o.references.length} reference${o.references.length !== 1 ? "s" : ""}` : ""
      return `${o.title ?? o.name}${refs}`
    },
  },

  skill_read_file: {
    label: "Skill File",
    loadingMessage: (input) => safeInputString(input, "file") ? `Reading ${safeInputString(input, "file")}…` : "Reading a skill file…",
    resultMessage: (out) => {
      const o = out as SkillFile
      if (!o.found) return "Skill file not found"
      return `${o.title ?? o.path ?? "Skill file loaded"}`
    },
  },

  portfolio_get_summary: {
    label: "Portfolio",
    loadingMessage: "Fetching your portfolio…",
    resultMessage: (out) => {
      const o = out as Portfolio
      return `${o.summary.positionCount} positions · $${o.summary.totalValueUSD.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    },
  },

  market_get_quote: {
    label: "Quote",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Looking up ${safeInputString(input, "ticker")}…` : "Looking up a quote…",
    resultMessage: (out) => {
      const o = out as Quote
      const sign = o.changePct >= 0 ? "+" : ""
      return `${o.ticker} $${o.price.toFixed(2)} (${sign}${o.changePct.toFixed(2)}%)`
    },
  },

  portfolio_get_position_detail: {
    label: "Position",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Reviewing ${safeInputString(input, "ticker")}…` : "Reviewing a position…",
    resultMessage: (out) => {
      const o = out as PositionDetail
      if (!o.position) return `${o.ticker} is not in portfolio`
      const sign = o.position.unrealizedPnLPct >= 0 ? "+" : ""
      return `${o.ticker} · ${o.position.quantity} shares · ${sign}${o.position.unrealizedPnLPct.toFixed(2)}%`
    },
  },

  portfolio_get_allocation: {
    label: "Allocation",
    loadingMessage: "Checking allocation…",
    resultMessage: (out) => {
      const o = out as Allocation
      return `${o.byTicker.length} positions · ${o.bySector.length} sectors`
    },
  },

  portfolio_get_risk_snapshot: {
    label: "Risk",
    loadingMessage: "Checking portfolio risk…",
    resultMessage: (out) => {
      const o = out as RiskSnapshot
      return `${o.positionCount} positions · top ${o.topPositionWeightPct.toFixed(1)}% · top 3 ${o.top3WeightPct.toFixed(1)}%`
    },
  },

  market_get_company_info: {
    label: "Company",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Looking up ${safeInputString(input, "ticker")}…` : "Looking up company information…",
    resultMessage: (out) => {
      const o = out as Company
      return o.sector ? `${o.name} · ${o.sector}` : o.name
    },
  },

  news_get_recent: {
    label: "News",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Fetching news for ${safeInputString(input, "ticker")}…` : "Fetching recent news…",
    resultMessage: (out) => {
      const o = out as NewsItem
      return `${o.length} article${o.length !== 1 ? "s" : ""} found`
    },
  },

  market_get_fundamentals: {
    label: "Fundamentals",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Checking fundamentals for ${safeInputString(input, "ticker")}…` : "Checking fundamentals…",
    resultMessage: (out) => {
      const o = out as Fundamentals
      const pe = o.peRatio != null ? `P/E ${o.peRatio.toFixed(1)}` : "P/E n/a"
      const cap = o.marketCap != null ? ` · $${(o.marketCap / 1_000).toFixed(1)}B cap` : ""
      return `${o.ticker} · ${pe}${cap}`
    },
  },

  market_get_earnings: {
    label: "Earnings",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Checking earnings for ${safeInputString(input, "ticker")}…` : "Checking earnings…",
    resultMessage: (out) => {
      const o = out as Earnings
      return o.next ? `Next ${new Date(o.next.date).toLocaleDateString()}` : `${o.past.length} past events`
    },
  },

  market_get_price_target: {
    label: "Price Target",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Checking price targets for ${safeInputString(input, "ticker")}…` : "Checking price targets…",
    resultMessage: (out) => {
      const o = out as PriceTarget
      const analysts = o.numberOfAnalysts ?? 0
      return o.targetMean != null ? `${analysts} analysts · mean $${o.targetMean.toFixed(2)}` : `${analysts} analysts`
    },
  },

  market_get_recommendation_trends: {
    label: "Recommendations",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Checking recommendations for ${safeInputString(input, "ticker")}…` : "Checking recommendations…",
    resultMessage: (out) => {
      const o = out as Recommendation
      return `${o.trends.length} period${o.trends.length !== 1 ? "s" : ""}`
    },
  },

  market_get_fx_rate: {
    label: "FX",
    loadingMessage: (input) => `Checking ${safeInputString(input, "from") ?? "USD"}/${safeInputString(input, "to") ?? "THB"}…`,
    resultMessage: (out) => {
      const o = out as FXRate
      return `${o.from}/${o.to} ${o.rate.toFixed(4)}`
    },
  },

  market_get_price_history_summary: {
    label: "Price History",
    loadingMessage: (input) => safeInputString(input, "ticker") ? `Summarizing ${safeInputString(input, "ticker")} history…` : "Summarizing price history…",
    resultMessage: (out) => {
      const o = out as PriceHistorySummary
      if (o.periodReturnPct == null) return `${o.ticker} · ${o.barCount} bars`
      const sign = o.periodReturnPct >= 0 ? "+" : ""
      return `${o.ticker} ${o.range} · ${sign}${o.periodReturnPct.toFixed(2)}%`
    },
  },

  research_search_web: {
    label: "Web Search",
    loadingMessage: (input) => safeInputString(input, "query") ? `Searching ${safeInputString(input, "query")}…` : "Searching the web…",
    resultMessage: (out) => {
      const o = out as ResearchSearch
      return `${o.results.length} result${o.results.length !== 1 ? "s" : ""} found`
    },
  },

  research_read_page: {
    label: "Page",
    loadingMessage: "Reading a source page…",
    resultMessage: (out) => {
      const o = out as ResearchPage
      const suffix = o.truncated ? " · truncated" : ""
      return `${o.title ?? "Page read"}${suffix}`
    },
  },

  analysis_run_code: {
    label: "Analysis",
    loadingMessage: "Running analysis…",
    resultMessage: (out) => {
      const o = out as AnalysisResult
      if (o.summary) return o.summary
      if (!o.success) return o.phase === "output" ? "Analysis output was invalid" : "Analysis failed"
      return o.durationMs != null ? `Completed in ${o.durationMs}ms` : "Completed"
    },
  },
}
