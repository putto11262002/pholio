import { describe, expect, it } from "vitest"
import { streamText } from "ai"
import { MockLanguageModelV3, simulateReadableStream } from "ai/test"

describe("chat reasoning stream", () => {
  it("preserves reasoning and final text in the UI message protocol", async () => {
    const model = new MockLanguageModelV3({
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
    const response = result.toUIMessageStreamResponse({ sendReasoning: true })
    const protocol = await response.text()
    const usage = await result.totalUsage

    expect(protocol).toContain('"type":"reasoning-start"')
    expect(protocol).toContain('"delta":"Check the portfolio first."')
    expect(protocol).toContain('"type":"reasoning-end"')
    expect(protocol).toContain('"delta":"Your largest position is AAPL."')
    expect(usage.outputTokenDetails.reasoningTokens).toBe(7)
  })
})
