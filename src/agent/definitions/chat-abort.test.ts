import { beforeEach, describe, expect, it, vi } from "vitest"
import { runChatAgent } from "./chat.server"
import { ChatTurnDiagnostics } from "@/agent/runtime/chat-failure.server"

const mocks = vi.hoisted(() => ({
  createAnalysisTools: vi.fn(() => ({})),
  createPortfolioTools: vi.fn(() => ({})),
  convertToModelMessages: vi.fn(async (messages) => messages),
  getMonthlySpend: vi.fn(async () => 0),
  resolveGeneralChatModelKey: vi.fn(() => "model"),
  streamText: vi.fn(),
}))

vi.mock("ai", () => ({
  convertToModelMessages: mocks.convertToModelMessages,
  InvalidToolInputError: { isInstance: vi.fn(() => false) },
  NoSuchToolError: { isInstance: vi.fn(() => false) },
  isStepCount: vi.fn(() => vi.fn()),
  streamText: mocks.streamText,
}))
vi.mock("@/agent/gateway.server", () => ({ createModel: vi.fn(() => "model") }))
vi.mock("@/agent/general-chat-models", () => ({
  generalChatModels: { model: { id: "provider/model" } },
  resolveGeneralChatModelKey: mocks.resolveGeneralChatModelKey,
}))
vi.mock("@/agent/skills/registry.server", () => ({
  listAgentSkills: vi.fn(async () => []),
}))
vi.mock("@/agent/tools/analysis.server", () => ({
  createAnalysisTools: mocks.createAnalysisTools,
}))
vi.mock("@/agent/tools/portfolio.server", () => ({
  createPortfolioTools: mocks.createPortfolioTools,
}))
vi.mock("@/agent/tools/research.server", () => ({
  createResearchTools: vi.fn(() => ({})),
}))
vi.mock("@/agent/tools/skills.server", () => ({ skillTools: {} }))
vi.mock("@/agent/tools/stock.server", () => ({ stockTools: { tool_a: {}, tool_b: {} } }))
vi.mock("@/agent/tools/errors.server", async (importOriginal) => importOriginal())
vi.mock("@/agent/usage/api.server", () => ({
  buildAiRun: vi.fn(),
  getMonthlyLimitUsd: vi.fn(() => 10),
  getMonthlySpend: mocks.getMonthlySpend,
  insertAiRun: vi.fn(async () => undefined),
}))

describe("runChatAgent", () => {
  beforeEach(() => {
    mocks.convertToModelMessages.mockClear()
    mocks.createPortfolioTools.mockReset()
    mocks.createPortfolioTools.mockReturnValue({})
    mocks.getMonthlySpend.mockReset()
    mocks.getMonthlySpend.mockResolvedValue(0)
    mocks.resolveGeneralChatModelKey.mockReset()
    mocks.resolveGeneralChatModelKey.mockReturnValue("model")
    mocks.streamText.mockReset()
    mocks.streamText.mockReturnValue({ stream: new ReadableStream() })
  })

  it("passes the request abort signal to the model and its tools", async () => {
    const controller = new AbortController()
    const defer = vi.fn()

    await runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      abortSignal: controller.signal,
      defer,
    })

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      })
    )
    expect(mocks.createAnalysisTools).toHaveBeenCalledWith("user-1", "thread-1", expect.any(Function), defer)
    expect(mocks.convertToModelMessages).toHaveBeenCalledWith([], {
      tools: expect.objectContaining({ tool_a: expect.any(Object), tool_b: expect.any(Object) }),
    })
  })

  it("makes zero-based step 19 tool-free and adds an explicit conclusion instruction", async () => {
    await runChatAgent({ messages: [], onEnd: vi.fn(), userId: "user-1", threadId: "thread-1" })
    const options = mocks.streamText.mock.calls[0]?.[0]
    const prepared = options.prepareStep({ stepNumber: 19 })

    expect(prepared.activeTools).toEqual([])
    expect(prepared.toolChoice).toBe("none")
    expect(prepared.instructions).toContain("final permitted model step")
    expect(options.stopWhen).not.toBeInstanceOf(Array)
    expect(options).not.toHaveProperty("repairToolCall")
    expect(options).not.toHaveProperty("experimental_repairToolCall")
  })

  it("disables only the sixth repeatedly failing tool and tells the model why", async () => {
    await runChatAgent({ messages: [], onEnd: vi.fn(), userId: "user-1", threadId: "thread-1" })
    const options = mocks.streamText.mock.calls[0]?.[0]
    const transform = options.experimental_transform({ tools: options.tools, stopStream: vi.fn() })
    const writer = transform.writable.getWriter()
    const reader = transform.readable.getReader()
    const draining = (async () => {
      while (!(await reader.read()).done) { /* drain so writes do not backpressure */ }
    })()
    for (let attempt = 0; attempt < 6; attempt++) {
      await writer.write({
        type: "tool-error",
        toolCallId: `call-${attempt}`,
        toolName: "tool_a",
        input: {},
        error: new Error("same failure"),
        dynamic: true,
      })
    }
    await writer.close()
    await draining

    const prepared = options.prepareStep({ stepNumber: 6 })
    expect(prepared.activeTools).toEqual(["tool_b"])
    expect(prepared.instructions).toContain("tool_a:")
    expect(prepared.instructions).toContain("repeated 6 times")
  })

  it("records a preflight failure once without logging sensitive error data", async () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-PREFLIGHT", now: () => 0, log })
    mocks.getMonthlySpend.mockRejectedValueOnce(Object.assign(new Error("private holdings and sk-secret"), {
      requestBodyValues: { messages: ["sensitive prompt"] },
    }))

    await expect(runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      diagnostics,
    })).rejects.toThrow("private holdings")

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "agent.chat.terminal_failure",
      referenceId: "CHAT-PREFLIGHT",
      phase: "usage_preflight",
      firstOutputArrived: false,
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain("private holdings")
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive prompt")
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret")
  })

  it("records a provider-start failure with the resolved model", async () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-PROVIDER", now: () => 0, log })
    mocks.streamText.mockImplementationOnce(() => {
      throw Object.assign(new Error("provider body contains a secret"), {
        name: "AI_APICallError",
        statusCode: 503,
        isRetryable: true,
        responseBody: "private provider response",
      })
    })

    await expect(runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      diagnostics,
    })).rejects.toThrow("provider body")

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: "CHAT-PROVIDER",
      phase: "provider_start",
      modelId: "provider/model",
      status: 503,
      code: "provider_api_error",
      retryable: true,
      firstOutputArrived: false,
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider response")
    expect(JSON.stringify(log.mock.calls)).not.toContain("provider body")
  })

  it("records model resolution failures in their exact phase", async () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-MODEL", now: () => 0, log })
    mocks.resolveGeneralChatModelKey.mockImplementationOnce(() => {
      throw new Error("invalid private model setting")
    })

    await expect(runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      diagnostics,
    })).rejects.toThrow("invalid private model")

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: "CHAT-MODEL",
      phase: "model_resolution",
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain("private model")
  })

  it("records tool construction failures in their exact phase", async () => {
    const log = vi.fn()
    const diagnostics = new ChatTurnDiagnostics({ referenceId: "CHAT-TOOLS", now: () => 0, log })
    mocks.createPortfolioTools.mockImplementationOnce(() => {
      throw new Error("private portfolio setup")
    })

    await expect(runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      diagnostics,
    })).rejects.toThrow("private portfolio setup")

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      referenceId: "CHAT-TOOLS",
      phase: "tool_setup",
      modelId: "provider/model",
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain("private portfolio")
  })
})
