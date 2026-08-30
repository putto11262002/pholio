import { describe, expect, it, vi } from "vitest"
import { ChatAgent } from "./chat-agent.server"

const mocks = vi.hoisted(() => ({
  getThreadOwnerUserId: vi.fn(),
  runChatAgent: vi.fn(),
}))

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }))
vi.mock("agents", () => ({ callable: () => <T>(method: T) => method }))
vi.mock("@/agent/definitions/chat.server", () => ({ runChatAgent: mocks.runChatAgent }))
vi.mock("@/thread/api.server", () => ({ getThreadOwnerUserId: mocks.getThreadOwnerUserId }))

describe("ChatAgent failure boundaries", () => {
  it("records a throwing thread lookup in its exact phase with one safe reference", async () => {
    const secret = "private thread lookup secret"
    mocks.getThreadOwnerUserId.mockRejectedValueOnce(new Error(secret))
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const agent = Object.create(ChatAgent.prototype) as ChatAgent
    Object.defineProperties(agent, {
      name: { value: "thread-1" },
      messages: { value: [] },
    })

    const response = await agent.onChatMessage(vi.fn())
    const protocol = await response.text()

    expect(mocks.runChatAgent).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    const entry = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(entry).toEqual(expect.objectContaining({
      event: "agent.chat.terminal_failure",
      phase: "thread_lookup",
      firstOutputArrived: false,
    }))
    expect(protocol.match(new RegExp(String(entry.referenceId), "gu"))).toHaveLength(1)
    expect(JSON.stringify(entry)).not.toContain(secret)
    expect(protocol).not.toContain(secret)
    log.mockRestore()
  })
})
