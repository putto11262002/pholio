import { describe, expect, it } from "vitest"
import { isStepCount, streamText, tool } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { z } from "zod"
import { AgentToolError, createToolErrorTransform, ToolFailureTracker } from "./errors.server"

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

describe("tool errors in a real AI SDK stream", () => {
  it("feeds normalized JSON to the next model step and then recovers", async () => {
    let call = 0
    let secondPrompt = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1
        if (call === 1) {
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call-1", toolName: "quote", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ] }),
          }
        }
        secondPrompt = JSON.stringify(options.prompt)
        return {
          stream: simulateReadableStream({ chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "I recovered with the available context." },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] }),
        }
      },
    })
    const tracker = new ToolFailureTracker()
    const result = streamText({
      model,
      prompt: "Get a quote",
      tools: {
        quote: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<Record<string, never>> => {
            throw new AgentToolError("Provider unavailable", "recoverable", "quote", "fetch")
          },
        }),
      },
      experimental_transform: createToolErrorTransform({ tracker }),
      stopWhen: isStepCount(3),
    })

    const parts = []
    for await (const part of result.stream) parts.push(part)

    expect(call).toBe(2)
    expect(secondPrompt).toContain('"success":false')
    expect(secondPrompt).toContain('"tool":"quote"')
    expect(secondPrompt).toContain('"phase":"fetch"')
    expect(parts).toContainEqual(expect.objectContaining({ type: "tool-result", output: expect.objectContaining({ success: false }) }))
    expect(await result.text).toBe("I recovered with the available context.")
  })

  it.each([
    ["capacity", true, 1_250],
    ["interrupted", false, undefined],
  ] as const)("preserves %s AgentToolError metadata in a real stream", async (category, retryable, retryAfterMs) => {
    let call = 0
    let secondPrompt = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1
        if (call === 1) {
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "analysis-error", toolName: "analysis", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ] }),
          }
        }
        secondPrompt = JSON.stringify(options.prompt)
        return {
          stream: simulateReadableStream({ chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-metadata" },
            { type: "text-delta", id: "text-metadata", delta: "Handled." },
            { type: "text-end", id: "text-metadata" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] }),
        }
      },
    })
    const result = streamText({
      model,
      prompt: "Analyze",
      tools: {
        analysis: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<Record<string, never>> => {
            throw new AgentToolError(
              "Sandbox unavailable",
              retryable ? "recoverable" : "terminal",
              "analysis",
              "exec",
              { category, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
            )
          },
        }),
      },
      experimental_transform: createToolErrorTransform({ tracker: new ToolFailureTracker() }),
      stopWhen: isStepCount(3),
    })
    for await (const _part of result.stream) { /* consume the real tool loop */ }
    expect(secondPrompt).toContain(`"category":"${category}"`)
    expect(secondPrompt).toContain(`"retryable":${retryable}`)
    if (retryAfterMs !== undefined) {
      expect(secondPrompt).toContain(`"retryAfterMs":${retryAfterMs}`)
    }
  })

  async function runInvalidToolCall(toolName: string, input: string) {
    let call = 0
    let secondPrompt = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1
        if (call === 1) {
          return {
            stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "invalid-call", toolName, input },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ] }),
          }
        }
        secondPrompt = JSON.stringify(options.prompt)
        return {
          stream: simulateReadableStream({ chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-2" },
            { type: "text-delta", id: "text-2", delta: "Handled the invalid call." },
            { type: "text-end", id: "text-2" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] }),
        }
      },
    })
    const result = streamText({
      model,
      prompt: "Use a tool",
      tools: {
        known: tool({
          inputSchema: z.object({ ticker: z.string() }),
          execute: async ({ ticker }) => ({ ticker }),
        }),
      },
      experimental_transform: createToolErrorTransform({ tracker: new ToolFailureTracker() }),
      stopWhen: isStepCount(3),
    })
    for await (const _part of result.stream) { /* consume the full loop */ }
    expect(call).toBe(2)
    return secondPrompt
  }

  it("classifies a real unknown tool call for the next model prompt", async () => {
    const prompt = await runInvalidToolCall("missing_tool", "{}")
    expect(prompt).toContain('"tool":"missing_tool"')
    expect(prompt).toContain('"phase":"selection"')
    expect(prompt).toContain('"category":"unavailable_tool"')
  })

  it("classifies real schema-invalid tool input for the next model prompt", async () => {
    const prompt = await runInvalidToolCall("known", '{"ticker":123}')
    expect(prompt).toContain('"tool":"known"')
    expect(prompt).toContain('"phase":"input"')
    expect(prompt).toContain('"category":"invalid_input"')
  })
})
