import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatAgent } from "./chat-agent.server"
import { CHAT_SETTLEMENT_TIMEOUT_MS } from "@/agent/chat-settlement"

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }))
vi.mock("agents", () => ({ callable: () => <T>(method: T) => method }))
vi.mock("@/agent/definitions/chat.server", () => ({ runChatAgent: vi.fn() }))
vi.mock("@/thread/api.server", () => ({ getThreadOwnerUserId: vi.fn() }))

type TestableChatAgent = ChatAgent & {
  waitUntilStable: (options?: { timeout?: number }) => Promise<boolean>
}

function createAgent(waitUntilStable: TestableChatAgent["waitUntilStable"]): ChatAgent {
  const agent = Object.create(ChatAgent.prototype) as TestableChatAgent
  Object.defineProperty(agent, "waitUntilStable", { value: waitUntilStable })
  return agent
}

describe("ChatAgent cancellation settlement", () => {
  beforeEach(() => vi.useRealTimers())

  it("holds the cancellation barrier until the old reply is stable", async () => {
    let releaseOldReply: ((stable: boolean) => void) | undefined
    const oldReplySettled = new Promise<boolean>((resolve) => {
      releaseOldReply = resolve
    })
    const waitUntilStable = vi.fn(() => oldReplySettled)
    const agent = createAgent(waitUntilStable)

    let resolved = false
    const barrier = agent.waitForTurnSettlement().then((result) => {
      resolved = true
      return result
    })
    await Promise.resolve()

    expect(resolved).toBe(false)
    expect(waitUntilStable).toHaveBeenCalledWith({ timeout: CHAT_SETTLEMENT_TIMEOUT_MS })

    releaseOldReply?.(true)
    await expect(barrier).resolves.toEqual({ status: "stable" })
  })

  it("returns a safe timeout result when the Agent does not become stable", async () => {
    vi.useFakeTimers()
    const agent = createAgent(({ timeout } = {}) => new Promise((resolve) => {
      setTimeout(() => resolve(false), timeout)
    }))

    const barrier = agent.waitForTurnSettlement()
    await vi.advanceTimersByTimeAsync(CHAT_SETTLEMENT_TIMEOUT_MS - 1)
    let resolved = false
    void barrier.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(barrier).resolves.toEqual({ status: "timeout" })
  })

  it("does not expose stability-check failures to the client", async () => {
    const agent = createAgent(() => Promise.reject(new Error("sensitive provider state")))

    await expect(agent.waitForTurnSettlement()).resolves.toEqual({ status: "unavailable" })
  })

  it("rejects unauthenticated connections before they can use the callable barrier", async () => {
    const agent = createAgent(vi.fn(() => Promise.resolve(true)))

    const response = await agent.onRequest(new Request("https://pholio.test/agents/chat/thread-1"))

    expect(response.status).toBe(401)
  })
})
