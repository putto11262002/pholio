import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { describe, expect, it, vi } from "vitest"
import type { InferUIMessageChunk } from "ai"
import type { ChatMessage } from "@/agent/chat-message"
import {
  createChatProgressEmitter,
  createChatProgressRunId,
} from "./chat-progress.server"

describe("chat progress emitter", () => {
  it("writes stable durable ordinals and exactly one terminal event", () => {
    const chunks: Array<InferUIMessageChunk<ChatMessage>> = []
    const emitter = createChatProgressEmitter({ runId: "request-7", write: (chunk) => chunks.push(chunk) })

    emitter.preparing()
    emitter.callbacks.waiting(0)
    emitter.completed()
    emitter.failed("late failure")

    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "data-chat-progress",
      "data-chat-progress",
      "data-chat-progress",
    ])
    const dataChunks = chunks.filter((chunk) => chunk.type === "data-chat-progress")
    expect(dataChunks.map((chunk) => chunk.id)).toEqual(["request-7:0", "request-7:1", "request-7:2"])
    expect(dataChunks.every((chunk) => chunk.transient === false)).toBe(true)
  })

  it("uses safe product copy for partial and unknown tool calls", () => {
    const write = vi.fn()
    const emitter = createChatProgressEmitter({ runId: "request-8", write })
    emitter.callbacks.toolStarted("market_get_quote", "call-1", {})
    emitter.callbacks.toolStarted("unknown_tool", "call-2", { raw: "do not show" })

    const events = write.mock.calls.map(([chunk]) => chunk.data)
    expect(events[0].message).toBe("Looking up a quote…")
    expect(events[1]).toMatchObject({ label: "Tool", message: "Running a tool…" })
    expect(JSON.stringify(events)).not.toContain("undefined")
    expect(JSON.stringify(events)).not.toContain("do not show")
  })

  it("creates a unique run for a reused continuation request id", () => {
    expect(createChatProgressRunId("request-a", "fixed"))
      .not.toBe(createChatProgressRunId("request-b", "fixed"))
    expect(createChatProgressRunId("request-9", "first")).toBe("request-9:first")
    expect(createChatProgressRunId("request-9", "second")).toBe("request-9:second")
    expect(createChatProgressRunId("request-9", "first"))
      .not.toBe(createChatProgressRunId("request-9", "second"))
  })

  it("writes one failed terminal before forwarding an asynchronous source error", async () => {
    const source = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
      async start(controller) {
        controller.enqueue({ type: "text-start", id: "text-1" })
        await Promise.resolve()
        controller.error(new Error("source exploded"))
      },
    })
    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        const emitter = createChatProgressEmitter({ runId: "request-error:unique", write: writer.write })
        emitter.preparing()
        const reader = source.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            writer.write(value)
          }
          emitter.completed()
        } catch (error) {
          emitter.failed("The response failed")
          throw error
        } finally {
          reader.releaseLock()
        }
      },
      onError: () => "Safe stream error",
    })
    const protocol = await createUIMessageStreamResponse({ stream }).text()

    expect(protocol.match(/\"phase\":\"failed\"/g)).toHaveLength(1)
    expect(protocol).toContain("Safe stream error")
    expect(protocol.indexOf('\"phase\":\"failed\"')).toBeLessThan(protocol.indexOf("Safe stream error"))
  })

  it("forwards final content before completing the durable rail", async () => {
    const chunks: Array<InferUIMessageChunk<ChatMessage>> = [
      { type: "text-start", id: "text-1" },
      ...Array.from({ length: 100 }, (_, index) => ({
        type: "text-delta" as const,
        id: "text-1",
        delta: `answer-${index} `,
      })),
      { type: "text-end", id: "text-1" },
    ]
    let pullCount = 0
    const source = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
      pull(controller) {
        const chunk = chunks[pullCount]
        pullCount += 1
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    }, { highWaterMark: 0 })
    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        const emitter = createChatProgressEmitter({ runId: "request-success:unique", write: writer.write })
        emitter.preparing()
        const reader = source.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            writer.write(value)
          }
          emitter.completed()
        } catch (error) {
          emitter.failed("The response failed")
          throw error
        } finally {
          reader.releaseLock()
        }
      },
      onError: () => "Safe stream error",
    })
    const protocol = await createUIMessageStreamResponse({ stream }).text()

    expect(pullCount).toBe(103)
    expect(protocol).toContain("answer-99")
    expect(protocol.match(/\"phase\":\"completed\"/g)).toHaveLength(1)
    expect(protocol.indexOf("answer-99"))
      .toBeLessThan(protocol.indexOf('\"phase\":\"completed\"'))
  })
})
