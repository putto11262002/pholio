import { describe, expect, it, vi } from "vitest"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { runChatAgent } from "./chat.server"
import { ChatTurnDiagnostics } from "@/agent/runtime/chat-failure.server"

const mocks = vi.hoisted(() => ({
  model: undefined as unknown as MockLanguageModelV4,
}))

vi.mock("@/agent/gateway.server", () => ({ createModel: () => mocks.model }))
vi.mock("@/agent/general-chat-models", () => ({
  generalChatModels: { model: { id: "provider/model" } },
  resolveGeneralChatModelKey: () => "model",
}))
vi.mock("@/agent/skills/registry.server", () => ({ listAgentSkills: () => Promise.resolve([]) }))
vi.mock("@/agent/tools/analysis.server", () => ({ createAnalysisTools: () => ({}) }))
vi.mock("@/agent/tools/portfolio.server", () => ({ createPortfolioTools: () => ({}) }))
vi.mock("@/agent/tools/research.server", () => ({ createResearchTools: () => ({}) }))
vi.mock("@/agent/tools/skills.server", () => ({ skillTools: {} }))
vi.mock("@/agent/tools/stock.server", () => ({ stockTools: {} }))
vi.mock("@/agent/usage/api.server", () => ({
  buildAiRun: vi.fn(),
  getMonthlyLimitUsd: () => 10,
  getMonthlySpend: () => Promise.resolve(0),
  insertAiRun: () => Promise.resolve(undefined),
}))

describe("runChatAgent stream diagnostics", () => {
  it("records one redacted provider-stream failure after output begins", async () => {
    const secret = "private prompt sk-stream-secret"
    const gatewayError = Object.assign(new Error(secret), {
      name: "GatewayTimeoutError",
      statusCode: 504,
      isRetryable: true,
      responseBody: "sensitive provider response",
      requestBodyValues: { messages: [secret], toolInput: { account: "private" } },
    })
    mocks.model = new MockLanguageModelV4({
      provider: "gateway",
      modelId: "provider/model",
      doStream: () => Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            {
              type: "text-delta",
              id: "text-1",
              delta: "Partial answer",
              providerMetadata: { gateway: { generationId: "gen_stream-123" } },
            },
            { type: "error", error: gatewayError },
          ],
        }),
      }),
    })
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-STREAM", now: () => 0, log })
    const result = await runChatAgent({
      messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      diagnostics,
    })

    const parts = []
    for await (const part of result.stream) parts.push(part)

    expect(parts).toContainEqual(expect.objectContaining({ type: "text-delta", text: "Partial answer" }))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent.chat.terminal_failure",
      referenceId: "CHAT-STREAM",
      phase: "provider_stream",
      modelId: "provider/model",
      firstOutputArrived: true,
      status: 504,
      code: "gateway_timeout",
      retryable: true,
    }))
    const serialized = JSON.stringify(log.mock.calls)
    expect(serialized).not.toContain("gen_stream-123")
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("sensitive provider response")
    expect(serialized).not.toContain("toolInput")
  })
})
