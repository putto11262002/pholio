import { InvalidToolInputError, NoSuchToolError } from "ai"
import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai"
import { MarketRateLimitError, MarketUpstreamError } from "@/market/errors"

export type AgentToolErrorMode = "recoverable" | "terminal"

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly mode: AgentToolErrorMode,
    readonly toolName: string,
    readonly phase?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AgentToolError"
  }
}

export type NormalizedToolFailure = {
  success: false
  tool: string
  phase: string
  category: string
  retryable: boolean
  message: string
  attempt: number
  retryAfterMs?: number
}

type FailureCounter = { signature: string; count: number }

const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 6
const MAX_ERROR_MESSAGE_LENGTH = 500
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000

export const EMPTY_FINAL_RESPONSE = "I couldn't produce a complete response. Please try again."
export const MISSING_STREAM_ERROR = "The response ended unexpectedly. Please try again."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function errorName(error: unknown): string {
  return isRecord(error) && typeof error.name === "string" ? error.name : ""
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (isRecord(error) && typeof error.message === "string") return error.message
  return "The tool failed without a usable error message."
}

export function sanitizeToolErrorMessage(error: unknown): string {
  const firstLine = errorMessage(error).split(/\n\s*at\s+/u, 1)[0] ?? ""
  const redacted = firstLine
    .replace(/\b((?:proxy-)?authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b(x-api-key\s*:\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^,]+/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*([^\s,;]+)/gu, "$1=[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim()

  if (!redacted) return "The tool failed without a usable error message."
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
}

function isAgentToolError(error: unknown): error is AgentToolError {
  return error instanceof AgentToolError || (
    isRecord(error)
    && error.name === "AgentToolError"
    && (error.mode === "recoverable" || error.mode === "terminal")
  )
}

function numericProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[key]
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined
}

function retryAfterMs(error: unknown): number | undefined {
  const direct = numericProperty(error, "retryAfterMs")
  const seconds = numericProperty(error, "retryAfterSeconds")
  const secondsInMs = seconds !== undefined && seconds <= MAX_RETRY_AFTER_MS / 1_000 ? seconds * 1_000 : undefined
  const candidate = direct
    ?? secondsInMs
    ?? (isAgentToolError(error) ? numericProperty(error.details, "retryAfterMs") : undefined)
  return candidate !== undefined && candidate <= MAX_RETRY_AFTER_MS ? candidate : undefined
}

function normalizedFailureSignature(failure: Omit<NormalizedToolFailure, "attempt">): string {
  const stableMessage = failure.message
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/giu, "[TIMESTAMP]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[REQUEST_ID]")
    .replace(/\b((?:request|trace|run|correlation)[ _-]?id\s*[=:]\s*)[A-Za-z0-9._-]+/giu, "$1[REQUEST_ID]")
    .replace(/\b\d{10,13}\b/gu, "[TIMESTAMP]")
  return `${failure.phase}\u0000${failure.category}\u0000${failure.retryable}\u0000${stableMessage}`
}

function classifyToolError(error: unknown, toolName: string): Omit<NormalizedToolFailure, "success" | "tool" | "message" | "attempt"> {
  const rawMessage = errorMessage(error)
  if (InvalidToolInputError.isInstance(error) || errorName(error) === "AI_InvalidToolInputError") {
    return { phase: "input", category: "invalid_input", retryable: false }
  }
  if (NoSuchToolError.isInstance(error) || errorName(error) === "AI_NoSuchToolError") {
    return { phase: "selection", category: "unavailable_tool", retryable: false }
  }
  // AI SDK 7 serializes these parse errors with getErrorMessage before stream
  // transforms run. Match only its tool-specific, anchored message contracts.
  if (rawMessage.startsWith(`AI_InvalidToolInputError: Invalid input for tool ${toolName}:`)) {
    return { phase: "input", category: "invalid_input", retryable: false }
  }
  if (rawMessage.startsWith(`AI_NoSuchToolError: Model tried to call unavailable tool '${toolName}'. `)) {
    return { phase: "selection", category: "unavailable_tool", retryable: false }
  }
  // Keep compatibility with providers that retain Error.message rather than
  // Error.toString(), still anchored to the exact SDK wording and tool name.
  if (rawMessage.startsWith(`Invalid input for tool ${toolName}:`)) {
    return { phase: "input", category: "invalid_input", retryable: false }
  }
  if (rawMessage.startsWith(`Model tried to call unavailable tool '${toolName}'. `)) {
    return { phase: "selection", category: "unavailable_tool", retryable: false }
  }

  const phase = isAgentToolError(error) && typeof error.phase === "string" && error.phase.trim() ? error.phase : "execute"
  const message = rawMessage.toLowerCase()
  const status = numericProperty(error, "status") ?? numericProperty(error, "statusCode")

  if (status === 429) {
    const retryAfter = retryAfterMs(error)
    return { phase, category: "rate_limit", retryable: true, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
  }
  if (status === 401) return { phase, category: "authentication", retryable: false }
  if (status === 403) return { phase, category: "permission", retryable: false }
  if (status === 404) return { phase, category: "not_found", retryable: false }
  if (status === 408) return { phase, category: "timeout", retryable: true }
  if (status !== undefined && status >= 400 && status <= 499) {
    return { phase, category: "invalid_request", retryable: false }
  }

  if (error instanceof MarketRateLimitError || errorName(error) === "MarketRateLimitError") {
    const retryAfter = retryAfterMs(error)
    return { phase, category: "rate_limit", retryable: true, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
  }
  if (error instanceof MarketUpstreamError || errorName(error) === "MarketUpstreamError") {
    return { phase, category: "upstream", retryable: true }
  }
  const researchHttpMatch = rawMessage.match(/^(?:Search failed|Page read failed) with HTTP (\d{3})$/u)
  if (researchHttpMatch) {
    const httpStatus = Number(researchHttpMatch[1])
    if (httpStatus === 429) return { phase, category: "rate_limit", retryable: true }
    if (httpStatus >= 500 && httpStatus <= 599) return { phase, category: "upstream", retryable: true }
  }

  if (errorName(error) === "TimeoutError" || /\b(?:timed? out|timeout)\b/u.test(message)) {
    return { phase, category: "timeout", retryable: true }
  }
  if (/\brate[ -]?limit/u.test(message)) {
    const retryAfter = retryAfterMs(error)
    return { phase, category: "rate_limit", retryable: true, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
  }
  if (/\b(?:unauthenticated|invalid api key)\b/u.test(message)) {
    return { phase, category: "authentication", retryable: false }
  }
  if (/\b(?:forbidden|permission denied)\b/u.test(message)) {
    return { phase, category: "permission", retryable: false }
  }
  if (/\bnot found\b/u.test(message)) {
    return { phase, category: "not_found", retryable: false }
  }
  if (status !== undefined && status >= 500) {
    const retryAfter = retryAfterMs(error)
    return { phase, category: "upstream", retryable: true, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
  }
  const retryAfter = retryAfterMs(error)
  return {
    phase,
    category: "execution",
    retryable: isAgentToolError(error) ? error.mode === "recoverable" : false,
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
  }
}

function isStructuredFailure(output: unknown): boolean {
  return isRecord(output) && output.success === false
}

export class ToolFailureTracker {
  private readonly counters = new Map<string, FailureCounter>()
  private readonly disabled = new Map<string, string>()

  recordFailure(failure: Omit<NormalizedToolFailure, "attempt">): NormalizedToolFailure {
    const signature = normalizedFailureSignature(failure)
    const previous = this.counters.get(failure.tool)
    const count = previous?.signature === signature ? previous.count + 1 : 1
    this.counters.set(failure.tool, { signature, count })

    if (count >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
      this.disabled.set(failure.tool, `${failure.category} failure in ${failure.phase} repeated ${count} times: ${failure.message}`)
    }
    return { ...failure, attempt: count }
  }

  recordResult(toolName: string, output: unknown, preliminary?: boolean): void {
    if (!preliminary && !isStructuredFailure(output)) this.counters.delete(toolName)
  }

  isDisabled(toolName: string): boolean {
    return this.disabled.has(toolName)
  }

  unavailableReasons(): string[] {
    return Array.from(this.disabled, ([tool, reason]) => `${tool}: ${reason}`)
  }
}

export function createToolErrorTransform<TOOLS extends ToolSet>({
  tracker,
  abortSignal,
}: {
  tracker: ToolFailureTracker
  abortSignal?: AbortSignal
}): StreamTextTransform<TOOLS> {
  return () => {
    let hasNonWhitespaceText = false
    let fallbackSequence = 0

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type === "start-step") hasNonWhitespaceText = false
        if (chunk.type === "text-delta" && chunk.text.trim()) hasNonWhitespaceText = true

        if (chunk.type === "tool-error") {
          // Parallel tool failures are counted in stream completion order. An actual
          // turn abort owns cancellation and must not affect breaker state.
          if (abortSignal?.aborted) {
            controller.enqueue(chunk)
            return
          }

          const classified = classifyToolError(chunk.error, chunk.toolName)
          const failure = tracker.recordFailure({
            success: false,
            tool: chunk.toolName,
            message: sanitizeToolErrorMessage(chunk.error),
            ...classified,
          })
          controller.enqueue({
            type: "tool-result",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: chunk.input,
            output: failure,
            dynamic: true,
            providerExecuted: chunk.providerExecuted,
            providerMetadata: chunk.providerMetadata,
            toolMetadata: chunk.toolMetadata,
            title: chunk.title,
          })
          return
        }

        if (chunk.type === "tool-result") tracker.recordResult(chunk.toolName, chunk.output, chunk.preliminary)

        if (chunk.type === "finish-step" && chunk.finishReason !== "tool-calls" && !hasNonWhitespaceText) {
          const id = `tool-contract-fallback-${fallbackSequence++}`
          controller.enqueue({ type: "text-start", id })
          controller.enqueue({ type: "text-delta", id, text: EMPTY_FINAL_RESPONSE })
          controller.enqueue({ type: "text-end", id })
          hasNonWhitespaceText = true
        }

        controller.enqueue(chunk)
      },
    })
  }
}
