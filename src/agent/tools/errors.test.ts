import { describe, expect, it } from "vitest"
import type { TextStreamPart, ToolSet } from "ai"
import { MarketRateLimitError, MarketUpstreamError } from "@/market/errors"
import { AgentToolError, createToolErrorTransform, EMPTY_FINAL_RESPONSE, sanitizeToolErrorMessage, ToolFailureTracker } from "./errors.server"

async function transformChunks(chunks: TextStreamPart<ToolSet>[], tracker = new ToolFailureTracker(), abortSignal?: AbortSignal) {
  const source = new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const transformed = source.pipeThrough(createToolErrorTransform({ tracker, abortSignal })({
    tools: {},
    stopStream: () => undefined,
  }))
  const result: TextStreamPart<ToolSet>[] = []
  const reader = transformed.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

function toolError(toolName: string, error: unknown, toolCallId = crypto.randomUUID()): TextStreamPart<ToolSet> {
  return { type: "tool-error", toolCallId, toolName, input: {}, error, dynamic: true }
}

describe("tool error contract", () => {
  it("normalizes execution failures, redacts secrets, and clips oversized messages", async () => {
    const secret = "sk-supersecretcredential123456"
    const error = new AgentToolError(`Request failed with Bearer token-value and ${secret}. ${"x".repeat(800)}`, "recoverable", "market", "fetch", {
      retryAfterMs: 250,
    })
    const [part] = await transformChunks([toolError("market", error)])

    expect(part).toMatchObject({
      type: "tool-result",
      output: {
        success: false,
        tool: "market",
        phase: "fetch",
        category: "execution",
        retryable: true,
        attempt: 1,
        retryAfterMs: 250,
      },
    })
    const message = (part as { output: { message: string } }).output.message
    expect(message).not.toContain(secret)
    expect(message).not.toContain("token-value")
    expect(message.length).toBeLessThanOrEqual(500)
  })

  it("changes signatures back to attempt one, resets after success, and isolates tools", async () => {
    const tracker = new ToolFailureTracker()
    const base = { success: false as const, phase: "execute", category: "execution", retryable: false }
    expect(tracker.recordFailure({ ...base, tool: "a", message: "one" }).attempt).toBe(1)
    expect(tracker.recordFailure({ ...base, tool: "a", message: "one" }).attempt).toBe(2)
    expect(tracker.recordFailure({ ...base, tool: "b", message: "one" }).attempt).toBe(1)
    expect(tracker.recordFailure({ ...base, tool: "a", message: "two" }).attempt).toBe(1)
    tracker.recordResult("a", { value: 1 })
    expect(tracker.recordFailure({ ...base, tool: "a", message: "two" }).attempt).toBe(1)
  })

  it.each([
    ["AI_InvalidToolInputError: Invalid input for tool market: AI_TypeValidationError: expected ticker", "input", "invalid_input"],
    ["AI_NoSuchToolError: Model tried to call unavailable tool 'market'. Available tools: quote.", "selection", "unavailable_tool"],
  ])("classifies serialized SDK failure %s", async (error, phase, category) => {
    const [part] = await transformChunks([toolError("market", error)])
    expect(part).toMatchObject({ type: "tool-result", output: { phase, category, retryable: false } })
  })

  it("does not classify loose mentions of invalid input or unavailable tools", async () => {
    const [part] = await transformChunks([toolError("market", "Upstream said invalid input for tool market")])
    expect(part).toMatchObject({ type: "tool-result", output: { phase: "execute", category: "execution" } })
  })

  it.each([
    ["Search failed with HTTP 429", "rate_limit"],
    ["Page read failed with HTTP 503", "upstream"],
  ])("classifies precise research HTTP failure %s as retryable", async (error, category) => {
    const [part] = await transformChunks([toolError("research", error)])
    expect(part).toMatchObject({ type: "tool-result", output: { phase: "execute", category, retryable: true } })
  })

  it("classifies market upstream errors without a numeric status as retryable", async () => {
    const [part] = await transformChunks([toolError("quote", new MarketUpstreamError("finnhub", "bad response"))])
    expect(part).toMatchObject({ type: "tool-result", output: { category: "upstream", retryable: true } })
  })

  it.each([
    [401, "authentication", false],
    [403, "permission", false],
    [404, "not_found", false],
    [408, "timeout", true],
    [429, "rate_limit", true],
    [503, "upstream", true],
  ])("gives HTTP status %i precedence for typed market upstream errors", async (status, category, retryable) => {
    const error = new MarketUpstreamError("finnhub", `HTTP ${status}`, { status })
    const [part] = await transformChunks([toolError("quote", error)])
    expect(part).toMatchObject({ type: "tool-result", output: { category, retryable } })
  })

  it.each([400, 405, 422])("treats typed market HTTP %i as a non-retryable invalid request", async (status) => {
    const error = new MarketUpstreamError("finnhub", `HTTP ${status}`, { status })
    const [part] = await transformChunks([toolError("quote", error)])
    expect(part).toMatchObject({
      type: "tool-result",
      output: { category: "invalid_request", retryable: false },
    })
  })

  it("converts bounded market retry-after seconds to milliseconds", async () => {
    const [part] = await transformChunks([toolError("quote", new MarketRateLimitError("finnhub", 12))])
    expect(part).toMatchObject({
      type: "tool-result",
      output: { category: "rate_limit", retryable: true, retryAfterMs: 12_000 },
    })
  })

  it("disables only a tool after its sixth identical completion-order failure", () => {
    const tracker = new ToolFailureTracker()
    const failure = { success: false as const, tool: "a", phase: "execute", category: "execution", retryable: false, message: "same" }
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(tracker.recordFailure(failure).attempt).toBe(attempt)
    }
    expect(tracker.isDisabled("a")).toBe(true)
    expect(tracker.isDisabled("b")).toBe(false)
    expect(tracker.unavailableReasons()[0]).toContain("a:")
  })

  it("keeps breaker signatures stable across request ids and timestamps", () => {
    const tracker = new ToolFailureTracker()
    const base = { success: false as const, tool: "a", phase: "fetch", category: "upstream", retryable: true }
    const first = tracker.recordFailure({ ...base, message: "request_id=req_abc failed at 2026-08-30T10:11:12Z" })
    const second = tracker.recordFailure({ ...base, message: "request_id=req_xyz failed at 2026-08-30T10:12:13Z" })
    expect(first.attempt).toBe(1)
    expect(second.attempt).toBe(2)
  })

  it("does not normalize or count a failure after the turn is aborted", async () => {
    const tracker = new ToolFailureTracker()
    const controller = new AbortController()
    controller.abort()
    const original = toolError("a", new DOMException("aborted", "AbortError"))
    const [part] = await transformChunks([original], tracker, controller.signal)
    expect(part).toBe(original)
    expect(tracker.isDisabled("a")).toBe(false)
    expect(tracker.unavailableReasons()).toEqual([])
  })

  it("injects a safe fallback before an empty terminal finish-step", async () => {
    const finish = {
      type: "finish-step" as const,
      finishReason: "stop" as const,
      rawFinishReason: "stop",
      usage: {
        inputTokens: 0,
        inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokens: 0,
        outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        totalTokens: 0,
      },
      performance: {
        effectiveOutputTokensPerSecond: 0,
        outputTokensPerSecond: undefined,
        inputTokensPerSecond: undefined,
        effectiveTotalTokensPerSecond: 0,
        stepTimeMs: 1,
        responseTimeMs: 1,
        toolExecutionMs: {},
        timeToFirstOutputMs: undefined,
      },
      providerMetadata: undefined,
      response: { id: "response-1", modelId: "test-model", timestamp: new Date(0) },
    }
    const parts = await transformChunks([finish])
    expect(parts.map((part) => part.type)).toEqual(["text-start", "text-delta", "text-end", "finish-step"])
    expect(parts[1]).toMatchObject({ type: "text-delta", text: EMPTY_FINAL_RESPONSE })
  })

  it("sanitizes stack traces and database credentials", () => {
    const safe = sanitizeToolErrorMessage(new Error("postgres://user:password@db.example/x?api_key=secret-value\n    at execute (/tmp/a.ts:1:1)"))
    expect(safe).toBe("postgres://[REDACTED]@db.example/x?api_key=[REDACTED]")
  })

  it("redacts credential-bearing HTTP headers", () => {
    expect(sanitizeToolErrorMessage("Failed x-api-key: topsecret")).toBe("Failed x-api-key: [REDACTED]")
    expect(sanitizeToolErrorMessage("Failed Authorization: Basic dXNlcjpwYXNz")).toBe("Failed Authorization: [REDACTED]")
    expect(sanitizeToolErrorMessage("Failed Cookie: session=secret; path=/")).toBe("Failed Cookie: [REDACTED]")
    expect(sanitizeToolErrorMessage("Failed Set-Cookie: session=secret; HttpOnly")).toBe("Failed Set-Cookie: [REDACTED]")
  })

  it("drops unreasonable retry-after values", async () => {
    const error = new AgentToolError("rate limit", "recoverable", "market", "fetch", { retryAfterMs: 86_400_001 })
    const [part] = await transformChunks([toolError("market", error)])
    expect((part as { output: Record<string, unknown> }).output).not.toHaveProperty("retryAfterMs")
  })
})
