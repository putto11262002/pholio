import { describe, expect, it, vi } from "vitest"
import type { InferUIMessageChunk } from "ai"
import type { ChatMessage } from "@/agent/chat-message"
import { forwardChatUIStream } from "./chat-agent.server"

vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }))
vi.mock("agents", () => ({ callable: () => <T>(method: T) => method }))
vi.mock("@/agent/definitions/chat.server", () => ({ runChatAgent: vi.fn() }))
vi.mock("@/thread/api.server", () => ({ getThreadOwnerUserId: vi.fn() }))

type Chunk = InferUIMessageChunk<ChatMessage>

describe("ChatAgent abort stream forwarding", () => {
  it("drops an abort error chunk and terminates as cancelled", async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Chunk>({
      start(streamController) {
        streamController.enqueue({ type: "text-start", id: "text-1" })
        controller.abort()
        streamController.enqueue({
          type: "error",
          errorText: "The response ended unexpectedly. Reference: CHAT-ABORTED.",
        })
        streamController.close()
      },
    })
    const write = vi.fn()
    const completed = vi.fn()
    const cancelled = vi.fn()

    await forwardChatUIStream({
      stream,
      abortSignal: controller.signal,
      write,
      completed,
      cancelled,
    })

    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[0]).toMatchObject({ type: "text-start" })
    expect(JSON.stringify(write.mock.calls)).not.toContain("CHAT-ABORTED")
    expect(completed).not.toHaveBeenCalled()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it("swallows a reader failure after abort without emitting a failure", async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Chunk>({
      start(streamController) {
        controller.abort()
        streamController.error(new Error("cancelled sandbox stream"))
      },
    })
    const cancelled = vi.fn()

    await expect(forwardChatUIStream({
      stream,
      abortSignal: controller.signal,
      write: vi.fn(),
      completed: vi.fn(),
      cancelled,
    })).resolves.toBeUndefined()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it("preserves genuine non-abort stream failures", async () => {
    const failure = new Error("provider failed")
    const stream = new ReadableStream<Chunk>({
      start(streamController) {
        streamController.error(failure)
      },
    })

    await expect(forwardChatUIStream({
      stream,
      write: vi.fn(),
      completed: vi.fn(),
      cancelled: vi.fn(),
    })).rejects.toBe(failure)
  })
})
