import { describe, expect, it, vi } from "vitest"
import { createUIMessageStream, createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { ChatTurnDiagnostics } from "./chat-failure.server"

describe("ChatTurnDiagnostics", () => {
  it("records exactly one terminal failure with safe correlation metadata", () => {
    const log = vi.fn()
    const times = [1_000, 1_275]
    const diagnostics = new ChatTurnDiagnostics({
      referenceId: "CHAT-TEST123",
      now: () => times.shift() ?? 1_275,
      log,
    })
    diagnostics.setModelId("deepseek/deepseek-v4-flash")
    diagnostics.markPhase("provider_stream")
    diagnostics.markFirstOutput()
    const gatewayError = Object.assign(new Error("sensitive prompt and sk-secret-value"), {
      name: "GatewayRateLimitError",
      statusCode: 429,
      isRetryable: true,
      generationId: "gen_safe-123",
      responseBody: "portfolio holdings and api_key=secret",
      requestBodyValues: { messages: ["private prompt"], toolInput: { symbol: "secret ticker" } },
      toolOutput: { accountNumber: "private account" },
    })

    expect(diagnostics.recordFailure(gatewayError)).toBe(true)
    expect(diagnostics.recordFailure(new Error("later secret"), "ui_stream")).toBe(false)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      event: "agent.chat.terminal_failure",
      referenceId: "CHAT-TEST123",
      phase: "provider_stream",
      modelId: "deepseek/deepseek-v4-flash",
      durationMs: 275,
      firstOutputArrived: true,
      status: 429,
      code: "gateway_rate_limit",
      retryable: true,
    })
    const serialized = JSON.stringify(log.mock.calls)
    expect(serialized).not.toContain("sensitive prompt")
    expect(serialized).not.toContain("sk-secret-value")
    expect(serialized).not.toContain("portfolio holdings")
    expect(serialized).not.toContain("api_key")
    expect(serialized).not.toContain("private prompt")
    expect(serialized).not.toContain("secret ticker")
    expect(serialized).not.toContain("private account")
    expect(serialized).not.toContain("gen_safe-123")
  })

  it("does not trust arbitrary error codes or unsafe generation identifiers", () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-SAFE", now: () => 0, log })
    diagnostics.recordFailure({
      name: "UserControlledError",
      code: "api_key=secret",
      generationId: "generation secret with spaces",
      message: "private portfolio",
      status: 503,
    })

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      code: "http_503",
      status: 503,
      retryable: true,
    }))
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("gatewayGenerationId")
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(log.mock.calls)).not.toContain("private portfolio")
  })

  it("emits one minimal record when proxies and getters throw", () => {
    const log = vi.fn()
    let nowCall = 0
    const diagnostics = new ChatTurnDiagnostics({
      referenceId: "CHAT-TRAPSAFE",
      now: () => {
        nowCall += 1
        if (nowCall > 1) throw new Error("clock secret")
        return 500
      },
      log,
    })
    const throwingError = new Proxy({}, {
      get() {
        throw new Error("getter secret")
      },
    })

    expect(diagnostics.recordFailure(throwingError)).toBe(true)
    expect(diagnostics.recordFailure(new Error("later"))).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      event: "agent.chat.terminal_failure",
      referenceId: "CHAT-TRAPSAFE",
      phase: "usage_preflight",
      durationMs: 0,
      firstOutputArrived: false,
      status: null,
      code: "unknown",
      retryable: false,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
  })

  it("omits token-shaped generation IDs even on named Gateway errors", () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-NOGEN", now: () => 0, log })
    diagnostics.recordFailure({
      name: "GatewayResponseError",
      statusCode: 502,
      generationId: "sk-proj-secret-token-shaped-value",
    })

    expect(log.mock.calls[0]?.[0]).not.toHaveProperty("gatewayGenerationId")
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-proj")
  })

  it("creates one short safe user reference", () => {
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-REF123", now: () => 0, log: vi.fn() })
    const message = diagnostics.userError("The response ended unexpectedly. Please try again.")

    expect(message).toBe("The response ended unexpectedly. Please try again. Reference: CHAT-REF123.")
    expect(message.match(/CHAT-REF123/gu)).toHaveLength(1)
  })

  it("emits one safe reference and one terminal log across real UI stream boundaries", async () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-UI123", now: () => 0, log })
    diagnostics.markPhase("provider_stream")
    const providerError = Object.assign(new Error("private prompt and provider body"), {
      name: "GatewayResponseError",
      statusCode: 502,
      generationId: "gen_ui-123",
      responseBody: "secret response",
    })
    const model = new MockLanguageModelV4({
      doStream: () => Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: providerError },
          ],
        }),
      }),
    })
    const result = streamText({
      model,
      prompt: "this prompt must not be logged",
      onError: ({ error }) => {
        diagnostics.recordFailure(error)
      },
    })
    const safeError = diagnostics.userError("The response ended unexpectedly. Please try again.")
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.merge(toUIMessageStream({ stream: result.stream, onError: () => safeError }))
      },
      onError: (error) => {
        diagnostics.recordFailure(error, "ui_stream")
        return safeError
      },
    })

    const protocol = await createUIMessageStreamResponse({ stream }).text()

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: "CHAT-UI123",
      phase: "provider_stream",
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain("gen_ui-123")
    expect(protocol.match(/CHAT-UI123/gu)).toHaveLength(1)
    expect(protocol).not.toContain("private prompt")
    expect(protocol).not.toContain("provider body")
    expect(protocol).not.toContain("secret response")
  })
})
