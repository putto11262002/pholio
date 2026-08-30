import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createAnalysisTools: vi.fn(() => ({})),
  streamText: vi.fn(),
}))

vi.mock("ai", () => ({
  convertToModelMessages: vi.fn(async (messages) => messages),
  InvalidToolInputError: { isInstance: vi.fn(() => false) },
  NoSuchToolError: { isInstance: vi.fn(() => false) },
  isStepCount: vi.fn(() => vi.fn()),
  streamText: mocks.streamText,
}))
vi.mock("@/agent/gateway.server", () => ({ createModel: vi.fn(() => "model") }))
vi.mock("@/agent/general-chat-models", () => ({
  generalChatModels: { model: { id: "provider/model" } },
  resolveGeneralChatModelKey: vi.fn(() => "model"),
}))
vi.mock("@/agent/skills/registry.server", () => ({
  listAgentSkills: vi.fn(async () => []),
}))
vi.mock("@/agent/tools/analysis.server", () => ({
  createAnalysisTools: mocks.createAnalysisTools,
}))
vi.mock("@/agent/tools/portfolio.server", () => ({
  createPortfolioTools: vi.fn(() => ({})),
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
  getMonthlySpend: vi.fn(async () => 0),
  insertAiRun: vi.fn(async () => undefined),
}))

import { runChatAgent } from "./chat.server"

describe("runChatAgent cancellation", () => {
  beforeEach(() => {
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
})
