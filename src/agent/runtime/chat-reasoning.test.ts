import { describe, expect, it } from "vitest"
import { createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { MISSING_STREAM_ERROR } from "@/agent/tools/errors.server"

describe("chat reasoning stream", () => {
  it("suppresses reasoning while preserving final text in the UI message protocol", async () => {
    const model = new MockLanguageModelV4({
      provider: "gateway",
      modelId: "deepseek/deepseek-v4-flash",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reasoning-1" },
            { type: "reasoning-delta", id: "reasoning-1", delta: "Check the portfolio first." },
            { type: "reasoning-end", id: "reasoning-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "Your largest position is AAPL." },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 15, text: 8, reasoning: 7 },
              },
            },
          ],
        }),
      }),
    })

    const result = streamText({ model, prompt: "What is my largest position?" })
    const response = createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream, sendReasoning: false }),
    })
    const protocol = await response.text()
    const usage = await result.usage

    expect(protocol).not.toContain('"type":"reasoning-start"')
    expect(protocol).not.toContain('"delta":"Check the portfolio first."')
    expect(protocol).not.toContain('"type":"reasoning-end"')
    expect(protocol).toContain('"delta":"Your largest position is AAPL."')
    expect(usage.outputTokenDetails.reasoningTokens).toBe(7)
  })

  it("maps a missing model finish to a safe UI-visible error", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [] }) }),
    })
    const result = streamText({ model, prompt: "hello" })
    const response = createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream, onError: () => MISSING_STREAM_ERROR }),
    })
    expect(await response.text()).toContain(MISSING_STREAM_ERROR)
  })
})
