import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}))

vi.mock("ai", () => ({
  convertToModelMessages: vi.fn(async (messages) => messages),
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
  createAnalysisTools: vi.fn(() => ({})),
}))
vi.mock("@/agent/tools/portfolio.server", () => ({
  createPortfolioTools: vi.fn(() => ({})),
}))
vi.mock("@/agent/tools/research.server", () => ({
  createResearchTools: vi.fn(() => ({})),
}))
vi.mock("@/agent/tools/skills.server", () => ({ skillTools: {} }))
vi.mock("@/agent/tools/stock.server", () => ({ stockTools: {} }))
vi.mock("@/agent/tools/errors.server", () => ({
  stopOnTerminalToolError: vi.fn(),
}))
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

    await runChatAgent({
      messages: [],
      onEnd: vi.fn(),
      userId: "user-1",
      threadId: "thread-1",
      abortSignal: controller.signal,
    })

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      })
    )
  })
})
