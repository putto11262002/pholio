import { useRef, useEffect, useLayoutEffect, useState, Suspense } from "react"
import { useMutation } from "@tanstack/react-query"
import { useAgent } from "agents/react"
import { useAgentChat } from "@cloudflare/ai-chat/react"
import { AlertCircle, ArrowUp, Brain, CheckCircle2, ChevronDown, Loader2, RotateCcw, Square } from "lucide-react"
import { Streamdown, type Components } from "streamdown"
import type { ChatMessage } from "@/agent/chat-message"
import { ArtifactBlock, ArtifactView, parseArtifact, type AnalysisArtifact } from "@/components/artifacts/analysis-artifacts"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { toolDisplayRegistry } from "@/agent/tool-display"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import {
  generalChatModels,
  DEFAULT_GENERAL_CHAT_MODEL,
  resolveGeneralChatModelKey,
  type GeneralChatModel,
  type GeneralChatModelKey,
  type ProviderOptions,
} from "@/agent/general-chat-models"
import { useAuth } from "@clerk/tanstack-react-start"
import { ConversationSidebar, ConversationToggle } from "@/components/chat/thread-switcher"
import { createThreadFn, deleteThreadFn, getThreadFn, updateThreadFn } from "@/thread/functions"
import type { Thread } from "@/thread/types"
import {
  beginTurn,
  cancelTurn as cancelTurnGeneration,
  completeTurn as completeTurnGeneration,
  createSelectionIntentTracker,
  createTurnGenerationQueue,
  initialTurnGenerationState,
  latestTurnGeneration,
  resolveCreatedThreadIntent,
  resolveChatLifecycle,
  retryTurn,
  turnGenerationForFinishedMessage,
  type ChatConnectionState,
  type ChatLifecycleState,
} from "@/components/chat/chat-lifecycle"

const THREAD_LS_KEY = "activeThreadId"

// ---------------------------------------------------------------------------
// Markdown / message rendering
// ---------------------------------------------------------------------------

function markdownComponents(sources: ResearchSource[], scope: string): Components {
  return {
  a: ({ node: _n, href, children, ...props }) => {
    if (typeof href === "string" && href.startsWith(`#citation-${scope}-`)) {
      const citationIds = href
        .replace(`#citation-${scope}-`, "")
        .split("-")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value))
      const citedSources = citationIds
        .map((citation) => sources.find((source) => source.citation === citation))
        .filter((source): source is ResearchSource => source != null)
      return <CitationPill sources={citedSources} />
    }
    return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
  },
  h1: ({ node: _n, ...props }) => <h1 className="text-base font-semibold mt-3 mb-1" {...props} />,
  h2: ({ node: _n, ...props }) => <h2 className="text-sm font-semibold mt-2 mb-1" {...props} />,
  h3: ({ node: _n, ...props }) => <h3 className="text-sm font-medium mt-2 mb-0.5" {...props} />,
  table: ({ node: _n, ...props }) => (
    <ScrollArea className="w-full rounded-4xl border">
      <table className="min-w-full caption-bottom text-sm" {...props} />
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
  thead: ({ node: _n, ...props }) => <TableHeader {...props} />,
  tbody: ({ node: _n, ...props }) => <TableBody {...props} />,
  tr: ({ node: _n, ...props }) => <TableRow {...props} />,
  th: ({ node: _n, ...props }) => <TableHead {...props} />,
  td: ({ node: _n, ...props }) => <TableCell {...props} />,
  }
}

type AnyPart = ChatMessage["parts"][number]

type ResearchSource = {
  citation?: number
  url: string
  title: string
  source?: string
  favicon?: string
  publishedAt?: string
  excerpt?: string
  snippet?: string
  read: boolean
  truncated?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toolNameForPart(part: AnyPart): string | null {
  if (part.type === "dynamic-tool") return (part as { toolName?: string }).toolName ?? null
  if (part.type.startsWith("tool-")) return part.type.replace(/^tool-/, "")
  return null
}

function outputForPart(part: AnyPart): unknown {
  const p = part as { state?: string; output?: unknown }
  return p.state === "output-available" ? p.output : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function optionalCitation(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function hostForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function faviconFallback(source: ResearchSource): string {
  const value = source.source ?? hostForUrl(source.url) ?? source.title
  return value.trim().charAt(0).toUpperCase() || "?"
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    return new URL(value).toString()
  } catch {
    return null
  }
}

function mergeSource(
  map: Map<string, ResearchSource>,
  source: ResearchSource,
) {
  const existing = map.get(source.url)
  if (!existing) {
    map.set(source.url, source)
    return
  }
  map.set(source.url, {
    ...existing,
    ...source,
    citation: existing.citation ?? source.citation,
    title: source.read && source.title ? source.title : existing.title,
    excerpt: source.excerpt ?? existing.excerpt,
    snippet: existing.snippet ?? source.snippet,
    source: source.source ?? existing.source,
    favicon: existing.favicon ?? source.favicon,
    publishedAt: source.publishedAt ?? existing.publishedAt,
    read: existing.read || source.read,
    truncated: existing.truncated || source.truncated,
  })
}

function extractResearchSources(message: ChatMessage): ResearchSource[] {
  const sources = new Map<string, ResearchSource>()
  for (const part of message.parts) {
    const toolName = toolNameForPart(part)
    const output = outputForPart(part)
    if (!toolName || !isRecord(output)) continue

    if (toolName === "research_search_web" && Array.isArray(output.results)) {
      for (const result of output.results) {
        if (!isRecord(result)) continue
        const url = normalizeUrl(result.url)
        if (!url) continue
        mergeSource(sources, {
          citation: optionalCitation(result.citation),
          url,
          title: optionalString(result.title) ?? hostForUrl(url),
          source: optionalString(result.source) ?? hostForUrl(url),
          favicon: optionalString(result.favicon),
          publishedAt: optionalString(result.publishedAt),
          snippet: optionalString(result.snippet),
          read: false,
        })
      }
    }

    if (toolName === "research_read_page") {
      const url = normalizeUrl(output.url)
      if (!url) continue
      mergeSource(sources, {
        citation: optionalCitation(output.citation),
        url,
        title: optionalString(output.title) ?? hostForUrl(url),
        source: optionalString(output.siteName) ?? hostForUrl(url),
        publishedAt: optionalString(output.publishedAt),
        excerpt: optionalString(output.excerpt),
        read: true,
        truncated: output.truncated === true,
      })
    }
  }
  const orderedSources = Array.from(sources.values()).sort((a, b) => {
    if (a.citation != null && b.citation != null) return a.citation - b.citation
    if (a.citation != null) return -1
    if (b.citation != null) return 1
    return 0
  })
  let nextFallbackCitation = orderedSources.reduce((max, source) => Math.max(max, source.citation ?? 0), 0) + 1
  return orderedSources.map((source) => {
    if (source.citation != null) return source
    const citation = nextFallbackCitation
    nextFallbackCitation += 1
    return { ...source, citation }
  })
}

function citationScope(message: ChatMessage): string {
  return message.id.replace(/[^a-zA-Z0-9_-]/g, "")
}

function rewriteCitationMarkersInPlainText(text: string, validCitations: Set<number>, scope: string): string {
  return text.replace(/(?:\[\d{1,2}\])+(?!\()/g, (match) => {
    const citations = Array.from(match.matchAll(/\[(\d{1,2})\]/g))
      .map((item) => Number.parseInt(item[1] ?? "", 10))
      .filter((citation) => Number.isInteger(citation) && validCitations.has(citation))
    if (citations.length === 0) return match
    return `[sources](#citation-${scope}-${citations.join("-")})`
  })
}

function rewriteOutsideInlineCode(text: string, validCitations: Set<number>, scope: string): string {
  let result = ""
  let cursor = 0
  const inlineCodePattern = /(`+)([\s\S]*?)\1/g
  for (const match of text.matchAll(inlineCodePattern)) {
    const index = match.index ?? 0
    result += rewriteCitationMarkersInPlainText(text.slice(cursor, index), validCitations, scope)
    result += match[0]
    cursor = index + match[0].length
  }
  result += rewriteCitationMarkersInPlainText(text.slice(cursor), validCitations, scope)
  return result
}

function linkCitationMarkers(text: string, sources: ResearchSource[], scope: string): string {
  if (sources.length === 0) return text
  const validCitations = new Set(sources.map((source) => source.citation).filter((citation): citation is number => citation != null))
  let result = ""
  let cursor = 0
  const fencedCodePattern = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2)(?=\n|$)/g
  for (const match of text.matchAll(fencedCodePattern)) {
    const index = match.index ?? 0
    result += rewriteOutsideInlineCode(text.slice(cursor, index), validCitations, scope)
    result += match[0]
    cursor = index + match[0].length
  }
  result += rewriteOutsideInlineCode(text.slice(cursor), validCitations, scope)
  return result
}

function CitationPill({ sources }: { sources: ResearchSource[] }) {
  if (sources.length === 0) return null
  const maxVisibleFavicons = 3
  const visibleSources = sources.slice(0, maxVisibleFavicons)
  const overflow = Math.max(0, sources.length - maxVisibleFavicons)
  const title = sources.map((source) => `[${source.citation}] ${source.title} - ${source.url}`).join("\n")
  const href = sources[0]?.url
  const pill = (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="not-prose bg-muted hover:bg-muted/80 inline-flex h-6 items-center rounded-full px-1.5 align-middle no-underline transition-colors"
    >
      <span className="flex items-center">
        {visibleSources.map((source, index) => (
          <span
            key={`${source.url}-${source.citation}`}
            className={cn(
              "bg-background text-muted-foreground inline-flex size-4 items-center justify-center overflow-hidden rounded-full text-[9px] font-medium",
              index > 0 && "-ml-1.5",
            )}
          >
            {source.favicon ? (
              <img src={source.favicon} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              faviconFallback(source)
            )}
          </span>
        ))}
      </span>
      {overflow > 0 && <span className="text-muted-foreground ml-1 text-[10px] font-medium">+{overflow}</span>}
    </a>
  )

  return (
    <HoverCard openDelay={120} closeDelay={160}>
      <HoverCardTrigger asChild>{pill}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="w-80 p-2"
      >
        <div className="space-y-1">
          {sources.map((source) => {
            const detail = source.excerpt ?? source.snippet
            return (
              <a
                key={`${source.url}-${source.citation}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-muted grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md p-2 no-underline transition-colors"
              >
                <span className="bg-muted text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center self-center overflow-hidden rounded-full text-[10px] font-medium">
                  {source.favicon ? (
                    <img src={source.favicon} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    faviconFallback(source)
                  )}
                </span>
                <span className="min-w-0 self-center">
                  <span className="text-foreground line-clamp-1 text-xs font-medium leading-tight">{source.title}</span>
                  <span className="text-muted-foreground mt-0.5 block truncate text-[11px] leading-tight">{source.source ?? hostForUrl(source.url)}</span>
                </span>
                {detail && <span className="text-muted-foreground col-span-2 line-clamp-2 text-[11px] leading-relaxed">{detail}</span>}
              </a>
            )
          })}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function extractAnalysisArtifacts(message: ChatMessage): AnalysisArtifact[] {
  const artifacts: AnalysisArtifact[] = []
  const seen = new Set<string>()
  for (const part of message.parts) {
    const toolName = toolNameForPart(part)
    if (toolName !== "analysis_run_code") continue
    const output = outputForPart(part)
    if (!isRecord(output) || !Array.isArray(output.artifacts)) continue
    for (const value of output.artifacts) {
      const artifact = parseArtifact(value)
      if (!artifact) continue
      const key = `${artifact.type}:${artifact.id}`
      if (seen.has(key)) continue
      seen.add(key)
      artifacts.push(artifact)
    }
  }
  return artifacts
}

function splitPlainTextWithArtifactMarkers(text: string, artifactsById: Map<string, AnalysisArtifact>) {
  const segments: Array<
    | { kind: "text"; text: string }
    | { kind: "artifact"; artifact: AnalysisArtifact }
  > = []
  const renderedArtifactIds = new Set<string>()
  let cursor = 0
  const markerPattern = /\[artifact:([A-Za-z_][A-Za-z0-9_-]{0,79})\]/g
  for (const match of text.matchAll(markerPattern)) {
    const index = match.index ?? 0
    const id = match[1] ?? ""
    const artifact = artifactsById.get(id)
    if (!artifact) continue
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) })
    segments.push({ kind: "artifact", artifact })
    renderedArtifactIds.add(id)
    cursor = index + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) })
  return { segments, renderedArtifactIds }
}

function splitOutsideInlineCodeWithArtifactMarkers(text: string, artifactsById: Map<string, AnalysisArtifact>) {
  const segments: Array<
    | { kind: "text"; text: string }
    | { kind: "artifact"; artifact: AnalysisArtifact }
  > = []
  const renderedArtifactIds = new Set<string>()
  let cursor = 0
  const inlineCodePattern = /(`+)([\s\S]*?)\1/g
  for (const match of text.matchAll(inlineCodePattern)) {
    const index = match.index ?? 0
    const before = splitPlainTextWithArtifactMarkers(text.slice(cursor, index), artifactsById)
    segments.push(...before.segments)
    for (const id of before.renderedArtifactIds) renderedArtifactIds.add(id)
    segments.push({ kind: "text", text: match[0] })
    cursor = index + match[0].length
  }
  const after = splitPlainTextWithArtifactMarkers(text.slice(cursor), artifactsById)
  segments.push(...after.segments)
  for (const id of after.renderedArtifactIds) renderedArtifactIds.add(id)
  return { segments, renderedArtifactIds }
}

function splitTextWithArtifactMarkers(text: string, artifacts: AnalysisArtifact[]) {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const segments: Array<
    | { kind: "text"; text: string }
    | { kind: "artifact"; artifact: AnalysisArtifact }
  > = []
  const renderedArtifactIds = new Set<string>()
  let cursor = 0
  const fencedCodePattern = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2)(?=\n|$)/g
  for (const match of text.matchAll(fencedCodePattern)) {
    const index = match.index ?? 0
    const before = splitOutsideInlineCodeWithArtifactMarkers(text.slice(cursor, index), artifactsById)
    segments.push(...before.segments)
    for (const id of before.renderedArtifactIds) renderedArtifactIds.add(id)
    segments.push({ kind: "text", text: match[0] })
    cursor = index + match[0].length
  }
  const after = splitOutsideInlineCodeWithArtifactMarkers(text.slice(cursor), artifactsById)
  segments.push(...after.segments)
  for (const id of after.renderedArtifactIds) renderedArtifactIds.add(id)
  if (segments.length === 0 && text) segments.push({ kind: "text", text })
  return { segments, renderedArtifactIds }
}

function toolPartRow(part: AnyPart) {
  const toolName =
    part.type === "dynamic-tool"
      ? (part as { toolName: string }).toolName
      : part.type.replace(/^tool-/, "")
  const p = part as { state: string; input?: unknown; output?: unknown; errorText?: string }
  const display = toolDisplayRegistry[toolName]
  const isLoading = p.state === "input-available" || p.state === "input-streaming" || p.state === "output-streaming"
  const isDone = p.state === "output-available"
  const isError = p.state === "output-error"
  const label = display?.label ?? toolName
  const loadingMsg =
    display == null ? `Running ${toolName}…`
    : typeof display.loadingMessage === "function"
    ? display.loadingMessage((p.input ?? {}) as Record<string, unknown>)
    : display.loadingMessage
  const resultMsg = isDone && display ? display.resultMessage(p.output) : null
  return { isLoading, isDone, isError, label, loadingMsg, resultMsg, errorText: isError ? (p as { errorText?: string }).errorText : undefined }
}

function RailNode({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-background relative z-10 flex size-4 shrink-0 items-center justify-center">
      {children}
    </span>
  )
}

function FaviconStack({ items }: { items: { url: string; favicon?: string; source?: string }[] }) {
  const cap = 5
  const visibleCount = items.length > cap ? cap - 1 : items.length
  const visible = items.slice(0, visibleCount)
  const overflow = Math.max(0, items.length - visibleCount)
  if (visible.length === 0 && overflow === 0) return null
  return (
    <span className="flex items-center">
      {visible.map((item, i) => (
        <span
          key={`${item.url}-${i}`}
          className={cn(
            "ring-border bg-background text-muted-foreground inline-flex size-4 items-center justify-center overflow-hidden rounded-full text-[9px] font-medium ring-1",
            i > 0 && "-ml-1.5",
          )}
        >
          {item.favicon ? (
            <img src={item.favicon} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            (item.source ?? hostForUrl(item.url)).charAt(0).toUpperCase() || "?"
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span className="ring-border bg-muted text-muted-foreground -ml-1.5 inline-flex size-4 items-center justify-center rounded-full text-[9px] font-medium ring-1">
          +{overflow}
        </span>
      )}
    </span>
  )
}

const richResultRenderers: Record<string, (output: unknown) => React.ReactNode> = {
  research_search_web: (output) => {
    if (!isRecord(output) || !Array.isArray(output.results)) return null
    type Item = { url: string; favicon?: string; source?: string }
    const items: Item[] = []
    for (const result of output.results) {
      if (!isRecord(result)) continue
      const url = normalizeUrl(result.url)
      if (!url) continue
      items.push({
        url,
        favicon: optionalString(result.favicon),
        source: optionalString(result.source) ?? hostForUrl(url),
      })
    }
    if (items.length === 0) return null
    return <FaviconStack items={items} />
  },
}

function RailRow({ part }: { part: AnyPart }) {
  if (part.type === "reasoning") {
    const text = (part as { text?: string }).text ?? ""
    return (
      <div className="text-muted-foreground flex min-w-0 items-center gap-2">
        <RailNode><Brain className="size-3" /></RailNode>
        <span className="text-foreground shrink-0 font-medium">Thinking</span>
        <span className="shrink-0 opacity-40">·</span>
        <span className="min-w-0 flex-1 truncate">{text || "…"}</span>
      </div>
    )
  }

  if (part.type === "reasoning-file") {
    return (
      <div className="text-muted-foreground flex min-w-0 items-center gap-2">
        <RailNode><Brain className="size-3" /></RailNode>
        <span className="text-foreground shrink-0 font-medium">Reasoning attachment</span>
        <span className="shrink-0 opacity-40">·</span>
        <span className="min-w-0 flex-1 truncate">{part.mediaType}</span>
      </div>
    )
  }

  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    const toolName = toolNameForPart(part)
    const { isLoading, isDone, isError, label, loadingMsg, resultMsg, errorText } = toolPartRow(part)
    const richNode = isDone && toolName ? richResultRenderers[toolName]?.((part as { output?: unknown }).output) : null
    return (
      <div className={cn("flex min-w-0 items-center gap-2", isError ? "text-destructive" : "text-muted-foreground")}>
        <RailNode>
          {isLoading && <Loader2 className="size-3 animate-spin" />}
          {isDone && <CheckCircle2 className="size-3 text-green-500" />}
          {isError && <AlertCircle className="size-3 text-destructive" />}
        </RailNode>
        <span className="text-foreground shrink-0 font-medium">{label}</span>
        <span className="shrink-0 opacity-40">·</span>
        <span className="min-w-0 flex-1 truncate">
          {isError ? errorText : isDone ? (richNode ?? resultMsg) : loadingMsg}
        </span>
      </div>
    )
  }

  return null
}

function IntermediateRail({ parts, isStreaming, isLast }: { parts: AnyPart[]; isStreaming: boolean; isLast: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null)
  const defaultOpen = isStreaming && isLast
  const open = override ?? defaultOpen

  const isActive = isStreaming && isLast
  const toolCount = parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool").length
  const summary = isActive
    ? "Working…"
    : toolCount > 0
    ? `Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`
    : "Thought it through"

  return (
    <div className="w-full text-xs">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-2 transition-colors"
      >
        {isActive ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <CheckCircle2 className="size-3 shrink-0" />}
        <span className="font-medium">{summary}</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && parts.length > 0 && (
        <div className="relative mt-2 space-y-2.5">
          <div className="bg-border absolute left-2 top-2 bottom-2 w-px" aria-hidden />
          {parts.map((part, i) => <RailRow key={i} part={part} />)}
        </div>
      )}
    </div>
  )
}

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2">
      <img src="/pholio-ai-logo.png" alt="" className="size-6 animate-bounce" />
      <span className="text-muted-foreground text-xs">Crunching numbers…</span>
    </div>
  )
}

function LifecycleNotice({ state, error, onRetry }: { state: ChatLifecycleState; error?: string; onRetry: () => void }) {
  const labels: Partial<Record<ChatLifecycleState, string>> = {
    connecting: "Connecting…",
    waiting: "Waiting for model…",
    streaming: "Responding…",
    recovering: "Recovering response…",
    continuing: "Continuing after tools…",
    completed: "Complete",
    cancelled: "Cancelled — partial response kept.",
  }
  if (state === "idle") return null
  if (state === "failed") {
    return (
      <div className="bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-2xl px-3 py-2 text-xs" role="alert">
        <span className="min-w-0 truncate">{error || "The response failed."}</span>
        <button type="button" onClick={onRetry} className="hover:bg-destructive/10 flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-medium">
          <RotateCcw className="size-3" /> Retry
        </button>
      </div>
    )
  }
  const isActive = state === "connecting" || state === "waiting" || state === "streaming" || state === "recovering" || state === "continuing"
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs" aria-live="polite">
      {isActive ? <Loader2 className="size-3 animate-spin" /> : state === "cancelled" ? <Square className="size-3 fill-current" /> : <CheckCircle2 className="size-3" />}
      <span>{labels[state]}</span>
    </div>
  )
}

function Message({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  if (message.role === "user") {
    const textPart = message.parts.find((p) => p.type === "text") as { text?: string } | undefined
    return (
      <div className="flex flex-col items-end gap-5">
        <div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap">
          {textPart?.text ?? ""}
        </div>
      </div>
    )
  }

  const sources = extractResearchSources(message)
  const sourceScope = citationScope(message)
  const artifacts = extractAnalysisArtifacts(message)
  const renderedArtifactIds = new Set<string>()

  type Block = { kind: "rail"; parts: AnyPart[] } | { kind: "text"; text: string }
  const blocks: Block[] = []
  for (const part of message.parts) {
    if (part.type === "step-start") continue
    if (part.type === "text") {
      blocks.push({ kind: "text", text: (part as { text?: string }).text ?? "" })
      continue
    }
    if (part.type === "reasoning" || part.type === "reasoning-file" || part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === "rail") last.parts.push(part)
      else blocks.push({ kind: "rail", parts: [part] })
    }
  }

  return (
    <div className="flex flex-col items-start gap-5">
      {blocks.map((block, i) => {
        const isLastBlock = i === blocks.length - 1
        if (block.kind === "rail") {
          return <IntermediateRail key={i} parts={block.parts} isStreaming={isStreaming} isLast={isLastBlock} />
        }
        const { segments, renderedArtifactIds: blockArtifactIds } = splitTextWithArtifactMarkers(block.text, artifacts)
        for (const id of blockArtifactIds) renderedArtifactIds.add(id)
        return (
          <div key={i} className="flex w-full flex-col gap-5">
            {segments.map((segment, si) => {
              if (segment.kind === "artifact") return <ArtifactView key={`${segment.artifact.type}-${segment.artifact.id}-${si}`} artifact={segment.artifact} />
              if (!segment.text.trim()) return null
              return (
                <div key={si} className="prose prose-sm dark:prose-invert w-full text-sm">
                  <Streamdown isAnimating={isStreaming} components={markdownComponents(sources, sourceScope)}>
                    {linkCitationMarkers(segment.text, sources, sourceScope)}
                  </Streamdown>
                </div>
              )
            })}
          </div>
        )
      })}
      <ArtifactBlock artifacts={artifacts.filter((artifact) => !renderedArtifactIds.has(artifact.id))} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConnectedChat — keyed by threadId so it fully remounts on thread switch
// ---------------------------------------------------------------------------

type ConnectedChatProps = {
  threadId: string
  modelKey: GeneralChatModelKey
  providerOptions: ProviderOptions
  activeTitle: string | null
  initialMessage?: string | null
  onInitialMessageSent?: () => void
  onModelSelect: (key: GeneralChatModelKey) => void
  onThinkingSelect: (opts: ProviderOptions) => void
  onAutoTitle: (title: string) => void
}

function ConnectedChat({
  threadId, modelKey, providerOptions, activeTitle,
  initialMessage, onInitialMessageSent,
  onModelSelect, onThinkingSelect, onAutoTitle,
}: ConnectedChatProps) {
  const lastPairRef = useRef<HTMLDivElement>(null)
  const prevLastPairRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const floatingRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const justSubmittedRef = useRef(false)
  const hasInitialScrolledRef = useRef(false)
  const hasConnectedRef = useRef(false)
  const [input, setInput] = useState("")
  const [modelOpen, setModelOpen] = useState(false)
  const [connectionState, setConnectionState] = useState<ChatConnectionState>("connecting")
  const [turnState, setTurnState] = useState(initialTurnGenerationState)
  const turnStateRef = useRef(initialTurnGenerationState)
  const turnCompletionQueueRef = useRef(createTurnGenerationQueue())

  function transitionTurn(update: (state: typeof initialTurnGenerationState) => typeof initialTurnGenerationState) {
    const next = update(turnStateRef.current)
    turnStateRef.current = next
    setTurnState(next)
    return next
  }

  function startTurn() {
    const generation = transitionTurn(beginTurn).current
    turnCompletionQueueRef.current.enqueue(generation)
    return generation
  }

  function startRetry() {
    const generation = transitionTurn(retryTurn).current
    turnCompletionQueueRef.current.enqueue(generation)
    return generation
  }

  const agent = useAgent({
    agent: "chat",
    name: threadId,
    onOpen: () => {
      hasConnectedRef.current = true
      setConnectionState("connected")
    },
    onClose: () => setConnectionState(hasConnectedRef.current ? "reconnecting" : "connecting"),
  })
  const {
    messages, sendMessage, regenerate, stop, clearError, status, error,
    isStreaming, isRecovering, isToolContinuation, connectionError,
  } = useAgentChat<unknown, ChatMessage>({
    agent,
    cancelOnClientAbort: false,
    body: () => ({ modelKey, providerOptions }),
    onFinish: ({ message, messages: finishedMessages, isAbort }) => {
      const generation = turnCompletionQueueRef.current.resolve(
        turnGenerationForFinishedMessage(message.id, finishedMessages),
      )
      if (generation === undefined) return
      transitionTurn((current) => isAbort
        ? cancelTurnGeneration(current, generation)
        : completeTurnGeneration(current, generation))
    },
  })

  const wasCancelled = turnState.cancelled === turnState.current && turnState.current > 0
  const hasCompletedTurn = status === "ready"
    && turnState.completed === turnState.current
    && turnState.current > 0
  const lifecycle = resolveChatLifecycle({
    connectionState, status, isStreaming, isRecovering, isToolContinuation,
    hasCompletedTurn, wasCancelled, hasError: Boolean(error || connectionError),
  })
  const isBusy = !wasCancelled && (
    status === "submitted" || status === "streaming" || isStreaming || isRecovering || isToolContinuation
  )

  useEffect(() => {
    if (turnStateRef.current.current > 0) return
    const persistedGeneration = latestTurnGeneration(messages)
    if (persistedGeneration !== undefined) {
      transitionTurn(() => ({ current: persistedGeneration, cancelled: null, completed: null }))
      return
    }
    if (isStreaming || isRecovering || isToolContinuation || status === "submitted" || status === "streaming") {
      startTurn()
    }
  }, [messages, isStreaming, isRecovering, isToolContinuation, status])

  const selectedModel = generalChatModels[modelKey] as GeneralChatModel
  const thinkingLevels = selectedModel.thinking?.levels ?? []
  const currentThinkingKey = thinkingLevels.find(
    (l) => JSON.stringify(l.providerOptions) === JSON.stringify(providerOptions)
  )?.key ?? null

  // Auto-title after first assistant reply
  useEffect(() => {
    if (activeTitle !== null) return
    const firstUser = messages.find((m) => m.role === "user")
    const hasAssistant = messages.some((m) => m.role === "assistant")
    if (!firstUser || !hasAssistant) return
    const textPart = firstUser.parts.find((p) => p.type === "text") as { text?: string } | undefined
    const title = textPart?.text?.slice(0, 60) ?? "New conversation"
    onAutoTitle(title)
  }, [messages, activeTitle, onAutoTitle])

  // Scroll to bottom on first load
  useEffect(() => {
    if (hasInitialScrolledRef.current || messages.length === 0) return
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
      hasInitialScrolledRef.current = true
    }
  }, [messages])

  // Send queued first message exactly once on mount (ref guards against Strict Mode double-invoke)
  const hasSentInitialRef = useRef(false)
  useEffect(() => {
    if (!initialMessage || hasSentInitialRef.current) return
    hasSentInitialRef.current = true
    const turnGeneration = startTurn()
    sendMessage({ text: initialMessage, metadata: { turnGeneration } })
    onInitialMessageSent?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refocus textarea when streaming ends
  useEffect(() => {
    if (!isBusy) textareaRef.current?.focus()
  }, [isBusy])

  // Keep paddingBottom in sync with floating input height
  useEffect(() => {
    const floating = floatingRef.current
    const scroll = scrollContainerRef.current
    if (!floating || !scroll) return
    const update = () => { scroll.style.paddingBottom = `${floating.offsetHeight + 16}px` }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(floating)
    return () => ro.disconnect()
  }, [])

  // Last pair minHeight so user message stays at scroll top
  useLayoutEffect(() => {
    if (!scrollContainerRef.current) return
    const container = scrollContainerRef.current
    if (prevLastPairRef.current && prevLastPairRef.current !== lastPairRef.current) {
      prevLastPairRef.current.style.minHeight = ""
    }
    if (lastPairRef.current) {
      const paddingBottom = parseFloat(window.getComputedStyle(container).paddingBottom)
      lastPairRef.current.style.minHeight = `${container.clientHeight - paddingBottom}px`
      prevLastPairRef.current = lastPairRef.current
    }
    if (justSubmittedRef.current) {
      justSubmittedRef.current = false
      if (lastPairRef.current) {
        const el = lastPairRef.current
        const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        container.scrollTop = elTop
      }
    }
  }, [messages])

  function submit() {
    const text = input.trim()
    if (!text || isBusy) return
    setInput("")
    const turnGeneration = startTurn()
    justSubmittedRef.current = true
    sendMessage({ text, metadata: { turnGeneration } })
  }

  function cancelTurn() {
    const generation = turnStateRef.current.current
    transitionTurn((current) => cancelTurnGeneration(current, generation))
    void stop()
  }

  function retry() {
    if (connectionError) {
      agent.reconnect()
      return
    }
    startRetry()
    clearError()
    void regenerate()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() }
  }

  return (
    <>
      {/* Messages */}
      <div ref={scrollContainerRef} className="h-full overflow-y-auto overscroll-none px-4 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
            <img src="/pholio-ai-logo.png" alt="" className="size-20" />
            <p className="text-muted-foreground text-base">How can I help?</p>
          </div>
        ) : (
          <div>
            {(() => {
              type Pair = { user: ChatMessage; userIdx: number; assistant: ChatMessage | null; assistantIdx: number | null }
              const leading: { msg: ChatMessage; idx: number }[] = []
              const pairs: Pair[] = []
              let i = 0
              while (i < messages.length && messages[i].role === "assistant") leading.push({ msg: messages[i], idx: i++ })
              while (i < messages.length) {
                if (messages[i].role === "user") {
                  const user = messages[i]; const userIdx = i++
                  const hasAssistant = i < messages.length && messages[i].role === "assistant"
                  const assistant = hasAssistant ? messages[i] : null
                  const assistantIdx = hasAssistant ? i++ : null
                  pairs.push({ user, userIdx, assistant, assistantIdx })
                } else { i++ }
              }
              return (
                <>
                  {leading.map(({ msg, idx }) => (
                    <div key={msg.id}><Message message={msg} isStreaming={isBusy && idx === messages.length - 1} /></div>
                  ))}
                  {pairs.map((pair, pi) => {
                    const isLast = pi === pairs.length - 1
                    return (
                      <div key={pair.user.id} ref={isLast ? lastPairRef : undefined} className="space-y-6 pt-6">
                        <div><Message message={pair.user} isStreaming={false} /></div>
                        {isLast && isBusy && (!pair.assistant || pair.assistant.parts.length === 0) && <WorkingIndicator />}
                        {pair.assistant && (
                          <div><Message message={pair.assistant} isStreaming={isBusy && pair.assistantIdx === messages.length - 1} /></div>
                        )}
                      </div>
                    )
                  })}
                </>
              )
            })()}
          </div>
        )}
      </div>

      {/* Floating input */}
      <div ref={floatingRef} className="absolute bottom-4 left-4 right-4 pointer-events-none flex flex-col gap-1.5">
        <div className="pointer-events-auto">
          <LifecycleNotice state={lifecycle} error={error?.message ?? connectionError?.message} onRetry={retry} />
        </div>
        <div className="pointer-events-auto">
          <InputGroup className="border-primary bg-background/80 backdrop-blur-sm shadow-xl ring-1 ring-primary/30 has-[[data-slot=input-group-control]:focus-visible]:border-primary has-[[data-slot=input-group-control]:focus-visible]:ring-primary/30">
            <InputGroupTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your portfolio…"
              className="max-h-32 px-4 pt-4 text-sm"
              rows={2}
              disabled={isBusy}
            />
            <InputGroupAddon align="block-end" className="justify-between">
              <div className="flex items-center gap-1">
                <Popover open={modelOpen} onOpenChange={setModelOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" disabled={isBusy}
                      className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                      {selectedModel.label}
                      <ChevronDown className="size-3 opacity-60" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-48 p-1 gap-0">
                    {(Object.keys(generalChatModels) as GeneralChatModelKey[]).map((key) => (
                      <button type="button" key={key} onClick={() => { onModelSelect(key); setModelOpen(false) }}
                        className={cn("w-full rounded-2xl px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
                          key === modelKey ? "text-foreground font-medium" : "text-muted-foreground")}>
                        {generalChatModels[key].label}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>

                {thinkingLevels.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" disabled={isBusy}
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                        Think: {thinkingLevels.find((l) => l.key === currentThinkingKey)?.label ?? "Off"}
                        <ChevronDown className="size-3 opacity-60" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" className="w-36 p-1 gap-0">
                      {thinkingLevels.map((level) => (
                        <button type="button" key={level.key} onClick={() => onThinkingSelect(level.providerOptions)}
                          className={cn("w-full rounded-2xl px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
                            level.key === currentThinkingKey ? "text-foreground font-medium" : "text-muted-foreground")}>
                          {level.label}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                )}
              </div>
              <InputGroupButton size="icon-sm" variant="default" onClick={isBusy ? cancelTurn : submit}
                disabled={!isBusy && !input.trim()} aria-label={isBusy ? "Stop response" : "Send message"}>
                {isBusy ? <Square className="size-3 fill-current" /> : <ArrowUp />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// ChatSkeleton — Suspense fallback while ConnectedChat fetches initial messages.
// Mirrors the real input layout (disabled) so the input doesn't disappear on
// thread switch / mount. Spinner only covers the messages area.
// ---------------------------------------------------------------------------

function ChatSkeleton({ modelKey, providerOptions }: { modelKey: GeneralChatModelKey; providerOptions: ProviderOptions }) {
  const selectedModel = generalChatModels[modelKey] as GeneralChatModel
  const thinkingLevels = selectedModel.thinking?.levels ?? []
  const currentThinkingKey = thinkingLevels.find(
    (l) => JSON.stringify(l.providerOptions) === JSON.stringify(providerOptions)
  )?.key ?? null

  return (
    <>
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>

      <div className="absolute bottom-4 left-4 right-4 pointer-events-none flex flex-col gap-1.5">
        <div className="pointer-events-auto">
          <InputGroup className="border-primary bg-background/80 backdrop-blur-sm shadow-xl ring-1 ring-primary/30 opacity-60">
            <InputGroupTextarea
              placeholder="Ask about your portfolio…"
              className="max-h-32 px-4 pt-4 text-sm"
              rows={2}
              disabled
            />
            <InputGroupAddon align="block-end" className="justify-between">
              <div className="flex items-center gap-1">
                <button type="button" disabled
                  className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground disabled:opacity-50">
                  {selectedModel.label}
                  <ChevronDown className="size-3 opacity-60" />
                </button>
                {thinkingLevels.length > 0 && (
                  <button type="button" disabled
                    className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground disabled:opacity-50">
                    Think: {thinkingLevels.find((l) => l.key === currentThinkingKey)?.label ?? "Off"}
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                )}
              </div>
              <InputGroupButton size="icon-sm" variant="default" disabled>
                <ArrowUp />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// PreChatInput — shown when no thread exists yet; creates thread on first send
// ---------------------------------------------------------------------------

type PreChatInputProps = {
  modelKey: GeneralChatModelKey
  providerOptions: ProviderOptions
  isLoading: boolean
  onModelSelect: (key: GeneralChatModelKey) => void
  onThinkingSelect: (opts: ProviderOptions) => void
  onSubmit: (text: string) => void
}

function PreChatInput({ modelKey, providerOptions, isLoading, onModelSelect, onThinkingSelect, onSubmit }: PreChatInputProps) {
  const [input, setInput] = useState("")
  const [modelOpen, setModelOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const floatingRef = useRef<HTMLDivElement>(null)

  const selectedModel = generalChatModels[modelKey] as GeneralChatModel
  const thinkingLevels = selectedModel.thinking?.levels ?? []
  const currentThinkingKey = thinkingLevels.find(
    (l) => JSON.stringify(l.providerOptions) === JSON.stringify(providerOptions)
  )?.key ?? null

  function submit() {
    const text = input.trim()
    if (!text || isLoading) return
    setInput("")
    onSubmit(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() }
  }

  return (
    <>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 text-center pointer-events-none">
        <img src="/pholio-ai-logo.png" alt="" className="size-20" />
        <p className="text-muted-foreground text-base">How can I help?</p>
      </div>

      <div ref={floatingRef} className="absolute bottom-4 left-4 right-4 pointer-events-none flex flex-col gap-1.5">
        <div className="pointer-events-auto">
          <InputGroup className="border-primary bg-background/80 backdrop-blur-sm shadow-xl ring-1 ring-primary/30 has-[[data-slot=input-group-control]:focus-visible]:border-primary has-[[data-slot=input-group-control]:focus-visible]:ring-primary/30">
            <InputGroupTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your portfolio…"
              className="max-h-32 px-4 pt-4 text-sm"
              rows={2}
              disabled={isLoading}
            />
            <InputGroupAddon align="block-end" className="justify-between">
              <div className="flex items-center gap-1">
                <Popover open={modelOpen} onOpenChange={setModelOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" disabled={isLoading}
                      className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                      {selectedModel.label}
                      <ChevronDown className="size-3 opacity-60" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-48 p-1 gap-0">
                    {(Object.keys(generalChatModels) as GeneralChatModelKey[]).map((key) => (
                      <button type="button" key={key} onClick={() => { onModelSelect(key); setModelOpen(false) }}
                        className={cn("w-full rounded-2xl px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
                          key === modelKey ? "text-foreground font-medium" : "text-muted-foreground")}>
                        {generalChatModels[key].label}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>

                {thinkingLevels.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" disabled={isLoading}
                        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                        Think: {thinkingLevels.find((l) => l.key === currentThinkingKey)?.label ?? "Off"}
                        <ChevronDown className="size-3 opacity-60" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" className="w-36 p-1 gap-0">
                      {thinkingLevels.map((level) => (
                        <button type="button" key={level.key} onClick={() => onThinkingSelect(level.providerOptions)}
                          className={cn("w-full rounded-2xl px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
                            level.key === currentThinkingKey ? "text-foreground font-medium" : "text-muted-foreground")}>
                          {level.label}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                )}
              </div>
              <InputGroupButton size="icon-sm" variant="default" onClick={submit} disabled={isLoading || !input.trim()}>
                {isLoading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// ChatPanel — thread management shell
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const { userId } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [activeTitle, setActiveTitle] = useState<string | null>(null)
  const [modelKey, setModelKey] = useState<GeneralChatModelKey>(DEFAULT_GENERAL_CHAT_MODEL)
  const [providerOptions, setProviderOptions] = useState<ProviderOptions>({})
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [creatingIntent, setCreatingIntent] = useState<number | null>(null)
  const selectionIntentRef = useRef(createSelectionIntentTracker())

  const createMutation = useMutation({
    mutationFn: (creation: { intent: number; text: string; modelKey: GeneralChatModelKey; providerOptions: ProviderOptions }) =>
      createThreadFn({ data: { modelKey: creation.modelKey, providerOptions: creation.providerOptions } }),
    onSuccess: async (id, creation) => {
      await resolveCreatedThreadIntent({
        id,
        intent: creation.intent,
        tracker: selectionIntentRef.current,
        select: (selectedId) => {
          setPendingMessage(creation.text)
          setActiveThreadId(selectedId)
          setActiveTitle(null)
          localStorage.setItem(THREAD_LS_KEY, selectedId)
        },
        remove: async (staleId) => {
          try {
            await deleteThreadFn({ data: { id: staleId } })
          } catch (error) {
            console.error("Failed to remove stale conversation", error)
          }
        },
      })
    },
    onSettled: (_data, _error, creation) => {
      if (selectionIntentRef.current.isCurrent(creation.intent)) setCreatingIntent(null)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (vars: Parameters<typeof updateThreadFn>[0]) => updateThreadFn(vars),
  })

  // Init — restore last thread if available, otherwise show empty (no server call)
  useEffect(() => {
    const restoreIntent = selectionIntentRef.current.capture()
    const stored = localStorage.getItem(THREAD_LS_KEY)
    if (stored) {
      getThreadFn({ data: { id: stored } })
        .then((t) => {
          if (!selectionIntentRef.current.isCurrent(restoreIntent)) return
          if (t) {
            const resolvedModelKey = resolveGeneralChatModelKey(t.modelKey)
            setActiveThreadId(t.id)
            setActiveTitle(t.title ?? null)
            setModelKey(resolvedModelKey)
            setProviderOptions({})
            localStorage.setItem(THREAD_LS_KEY, t.id)
          } else {
            localStorage.removeItem(THREAD_LS_KEY)
          }
        })
        .catch(() => {
          if (selectionIntentRef.current.isCurrent(restoreIntent)) localStorage.removeItem(THREAD_LS_KEY)
        })
        .finally(() => setInitialized(true))
    } else {
      setInitialized(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleThreadSelect(t: Thread) {
    selectionIntentRef.current.supersede()
    setCreatingIntent(null)
    const resolvedModelKey = resolveGeneralChatModelKey(t.modelKey)
    setActiveThreadId(t.id)
    setActiveTitle(t.title ?? null)
    setModelKey(resolvedModelKey)
    setProviderOptions({})
    setPendingMessage(null)
    localStorage.setItem(THREAD_LS_KEY, t.id)
  }

  function handleNewConversation() {
    selectionIntentRef.current.supersede()
    setCreatingIntent(null)
    setActiveThreadId(null)
    setActiveTitle(null)
    setModelKey(DEFAULT_GENERAL_CHAT_MODEL)
    setProviderOptions({})
    setPendingMessage(null)
    localStorage.removeItem(THREAD_LS_KEY)
  }

  function handleModelSelect(key: GeneralChatModelKey) {
    const defaultOpts = (generalChatModels[key] as GeneralChatModel).thinking?.default ?? {}
    setModelKey(key)
    setProviderOptions(defaultOpts)
    if (activeThreadId) {
      updateMutation.mutate({ data: { id: activeThreadId, modelKey: key, providerOptions: defaultOpts } })
    }
  }

  function handleThinkingSelect(opts: ProviderOptions) {
    setProviderOptions(opts)
    if (activeThreadId) {
      updateMutation.mutate({ data: { id: activeThreadId, providerOptions: opts } })
    }
  }

  function handleAutoTitle(title: string) {
    setActiveTitle(title)
    if (activeThreadId) {
      updateMutation.mutate({ data: { id: activeThreadId, title } })
    }
  }

  // Called from the pre-chat input — create thread then hand off the message
  function handleFirstMessage(text: string) {
    const intent = selectionIntentRef.current.supersede()
    setCreatingIntent(intent)
    createMutation.mutate({ intent, text, modelKey, providerOptions })
  }

  return (
    <div className="relative h-full">
      {/* Top-left toggle */}
      <div className="absolute top-4 left-4 z-10" onMouseEnter={() => setSidebarOpen(true)}>
        <ConversationToggle onClick={() => setSidebarOpen((o) => !o)} />
      </div>

      {/* Conversation sidebar */}
      <ConversationSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userId={userId ?? ""}
        activeThreadId={activeThreadId}
        onSelect={handleThreadSelect}
        onNew={handleNewConversation}
      />

      {initialized && !activeThreadId && (
        <PreChatInput
          modelKey={modelKey}
          providerOptions={providerOptions}
          isLoading={creatingIntent !== null}
          onModelSelect={handleModelSelect}
          onThinkingSelect={handleThinkingSelect}
          onSubmit={handleFirstMessage}
        />
      )}

      {initialized && activeThreadId && (
        <Suspense fallback={<ChatSkeleton modelKey={modelKey} providerOptions={providerOptions} />}>
          <ConnectedChat
            key={activeThreadId}
            threadId={activeThreadId}
            modelKey={modelKey}
            providerOptions={providerOptions}
            activeTitle={activeTitle}
            initialMessage={pendingMessage}
            onInitialMessageSent={() => setPendingMessage(null)}
            onModelSelect={handleModelSelect}
            onThinkingSelect={handleThinkingSelect}
            onAutoTitle={handleAutoTitle}
          />
        </Suspense>
      )}
    </div>
  )
}
