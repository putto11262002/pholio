import { describe, expect, it, vi } from "vitest"
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  experimental_toolCaller,
  isStepCount,
  modelMessageSchema,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
  tool,
  validateUIMessages,
} from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { z } from "zod"
import {
  normalizeToolOutput,
  withJsonSafeToolOutputs,
} from "./json-safe.server"
import type { InferUITools, UIDataTypes, UIMessage, UIMessageChunk } from "ai"

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

function toolCallChunks(toolName: string, toolCallId: string) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "tool-call" as const, toolCallId, toolName, input: "{}" },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
      usage,
    },
  ]
}

function finalTextChunks(id: string, text: string) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id },
    { type: "text-delta" as const, id, delta: text },
    { type: "text-end" as const, id },
    {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
    },
  ]
}

describe("normalizeToolOutput", () => {
  it("normalizes values according to the JSON boundary contract", () => {
    const date = new Date("2026-08-30T02:03:04.000Z")

    expect(
      normalizeToolOutput({
        date,
        invalidDate: new Date(Number.NaN),
        missing: undefined,
        largeInteger: 9_007_199_254_740_993n,
        finite: 12.5,
        nonFinite: [
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ],
        nested: [undefined, { at: date }],
      })
    ).toEqual({
      date: "2026-08-30T02:03:04.000Z",
      invalidDate: null,
      missing: null,
      largeInteger: "9007199254740993",
      finite: 12.5,
      nonFinite: [null, null, null],
      nested: [null, { at: "2026-08-30T02:03:04.000Z" }],
    })
    expect(normalizeToolOutput(undefined)).toBeNull()
  })

  it("allows repeated references but rejects circular structures with a useful path", () => {
    const shared = { ticker: "AAPL" }
    expect(normalizeToolOutput({ first: shared, second: shared })).toEqual({
      first: { ticker: "AAPL" },
      second: { ticker: "AAPL" },
    })

    const circular: { child?: unknown } = {}
    circular.child = circular
    expect(() => normalizeToolOutput(circular)).toThrowError(
      "Tool output contains a circular reference at $.child"
    )
  })

  it.each([Symbol("unsafe"), () => "unsafe"])(
    "rejects unsupported %s values",
    (value) => {
      expect(() => normalizeToolOutput({ value })).toThrowError(
        /unsupported (symbol|function) at \$\.value/
      )
    }
  )

  it("rejects custom instances instead of exposing enumerable internals", () => {
    class ProviderPayload {
      secret = "must-not-leak"
      toJSON() {
        return { safe: true }
      }
    }

    expect(() => normalizeToolOutput(new ProviderPayload())).toThrowError(
      "Tool output contains unsupported custom object at $"
    )
  })
})

describe("JSON-safe tool boundary", () => {
  it("wraps executable tools without changing metadata or execution arguments", async () => {
    const execute = vi.fn(async () => ({
      asOf: new Date("2026-08-30T00:00:00.000Z"),
    }))
    const tools = withJsonSafeToolOutputs({
      portfolio: tool({
        description: "Portfolio",
        inputSchema: z.object({}),
        execute,
      }),
    })
    const options = {
      toolCallId: "call-1",
      messages: [],
      context: undefined as never,
    }

    expect(tools.portfolio.description).toBe("Portfolio")
    await expect(tools.portfolio.execute({}, options)).resolves.toEqual({
      asOf: "2026-08-30T00:00:00.000Z",
    })
    expect(execute).toHaveBeenCalledWith({}, options)
  })

  it("preserves non-enumerable tool callers and extra intersection members", () => {
    const caller = {
      type: "provider" as const,
      prepareProviderOptions: vi.fn((providerOptions) => providerOptions ?? {}),
    }
    const base = experimental_toolCaller(tool({
      inputSchema: z.object({}),
      execute: async () => ({ asOf: new Date("2026-08-30T00:00:00.000Z") }),
    }), caller)
    const extra = { source: "portfolio" as const }
    Object.defineProperty(base, "extraRuntimeMetadata", {
      value: extra,
      enumerable: false,
      configurable: false,
      writable: false,
    })
    const tools = withJsonSafeToolOutputs({
      portfolio: base as typeof base & { readonly extraRuntimeMetadata: typeof extra },
    })

    const callerDescriptor = Object.getOwnPropertyDescriptor(
      tools.portfolio,
      "experimental_toolCaller"
    )
    const extraDescriptor = Object.getOwnPropertyDescriptor(
      tools.portfolio,
      "extraRuntimeMetadata"
    )
    const typedSource: "portfolio" = tools.portfolio.extraRuntimeMetadata.source

    expect(typedSource).toBe("portfolio")
    expect(tools.portfolio.experimental_toolCaller).toBe(caller)
    expect(callerDescriptor).toEqual(expect.objectContaining({
      value: caller,
      enumerable: false,
    }))
    expect(tools.portfolio.extraRuntimeMetadata).toBe(extra)
    expect(extraDescriptor).toEqual({
      value: extra,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  })

  it("reaches the second real AI SDK model step with Date-containing portfolio data", async () => {
    let call = 0
    let secondPrompt = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: toolCallChunks("portfolio_get_summary", "portfolio-1"),
            }),
          }
        }
        secondPrompt = JSON.stringify(options.prompt)
        return {
          stream: simulateReadableStream({
            chunks: finalTextChunks("text-1", "Portfolio reviewed."),
          }),
        }
      },
    })
    const tools = withJsonSafeToolOutputs({
      portfolio_get_summary: tool({
        inputSchema: z.object({}),
        execute: async () => ({
          asOf: new Date("2026-08-30T01:02:03.000Z"),
          positions: [
            { ticker: "AAPL", openedAt: new Date("2026-01-02T00:00:00.000Z") },
          ],
        }),
      }),
    })
    const result = streamText({
      model,
      prompt: "Review my portfolio",
      tools,
      stopWhen: isStepCount(3),
    })

    for await (const _part of result.stream) {
      /* consume the real multi-step loop */
    }

    expect(call).toBe(2)
    expect(secondPrompt).toContain('"asOf":"2026-08-30T01:02:03.000Z"')
    expect(secondPrompt).toContain('"openedAt":"2026-01-02T00:00:00.000Z"')
    expect(await result.text).toBe("Portfolio reviewed.")
  })

  it("preserves async tool streams and normalizes every preliminary and final result", async () => {
    let call = 0
    let secondPrompt = ""
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: toolCallChunks("portfolio_stream", "stream-1"),
            }),
          }
        }
        secondPrompt = JSON.stringify(options.prompt)
        return {
          stream: simulateReadableStream({
            chunks: finalTextChunks("text-stream", "Done."),
          }),
        }
      },
    })
    const tools = withJsonSafeToolOutputs({
      portfolio_stream: tool({
        inputSchema: z.object({}),
        execute: async function* () {
          yield { asOf: new Date("2026-08-30T01:00:00.000Z"), stage: 1 }
          yield { asOf: new Date("2026-08-30T02:00:00.000Z"), stage: 2 }
        },
      }),
    })
    const result = streamText({
      model,
      prompt: "Stream portfolio",
      tools,
      stopWhen: isStepCount(3),
    })
    const toolResults = []
    for await (const part of result.stream) {
      if (part.type === "tool-result") toolResults.push(part)
    }

    expect(call).toBe(2)
    expect(toolResults).toEqual([
      expect.objectContaining({
        output: { asOf: "2026-08-30T01:00:00.000Z", stage: 1 },
        preliminary: true,
      }),
      expect.objectContaining({
        output: { asOf: "2026-08-30T02:00:00.000Z", stage: 2 },
        preliminary: true,
      }),
      expect.objectContaining({
        output: { asOf: "2026-08-30T02:00:00.000Z", stage: 2 },
      }),
    ])
    expect(toolResults[2]).not.toHaveProperty("preliminary")
    expect(secondPrompt).toContain('"asOf":"2026-08-30T02:00:00.000Z"')
  })

  it("persists and replays null for an empty async tool stream", async () => {
    const tools = withJsonSafeToolOutputs({
      portfolio_empty: tool({
        inputSchema: z.object({}),
        execute: async function* (): AsyncGenerator<undefined, void, unknown> {
          return
        },
      }),
    })
    type EmptyStreamMessage = UIMessage<
      unknown,
      UIDataTypes,
      InferUITools<typeof tools>
    >
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1
        return call === 1
          ? {
              stream: simulateReadableStream({
                chunks: toolCallChunks("portfolio_empty", "empty-1"),
              }),
            }
          : {
              stream: simulateReadableStream({
                chunks: finalTextChunks("text-empty", "No portfolio data."),
              }),
            }
      },
    })
    const result = streamText({
      model,
      prompt: "Check the empty portfolio",
      tools,
      stopWhen: isStepCount(3),
    })
    const response = createUIMessageStreamResponse({
      stream: toUIMessageStream<typeof tools, EmptyStreamMessage>({
        stream: result.stream,
        tools,
        generateMessageId: () => "assistant-empty",
      }),
    })
    const sse = await response.text()
    const chunks = sse
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk)
    const chunkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    let completed: EmptyStreamMessage | undefined
    for await (const snapshot of readUIMessageStream<EmptyStreamMessage>({
      stream: chunkStream,
    })) {
      completed = snapshot
    }
    const persisted = JSON.parse(JSON.stringify(completed)) as EmptyStreamMessage
    const validated = await validateUIMessages<EmptyStreamMessage>({
      messages: [persisted],
      tools,
    })
    const modelMessages = await convertToModelMessages(validated, { tools })

    expect(sse).toContain('"output":null')
    expect(validated).toEqual([persisted])
    expect(JSON.stringify(modelMessages)).toContain('"output":{"type":"json","value":null}')
    expect(modelMessages.every((message) => modelMessageSchema.safeParse(message).success)).toBe(true)
  })

  it("replaces pre-normalization output schemas and rejects incompatible model converters", async () => {
    const tools = withJsonSafeToolOutputs({
      portfolio: tool({
        inputSchema: z.object({}),
        outputSchema: z.object({ asOf: z.date() }),
        execute: async () => ({ asOf: new Date("2026-08-30T00:00:00.000Z") }),
      }),
    })
    const output = await tools.portfolio.execute(
      {},
      { toolCallId: "schema-1", messages: [], context: undefined as never }
    )
    const replay = [
      {
        id: "assistant-schema",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-portfolio" as const,
            toolCallId: "schema-1",
            state: "output-available" as const,
            input: {},
            output,
          },
        ],
      },
    ]

    type SchemaMessage = UIMessage<
      unknown,
      UIDataTypes,
      InferUITools<typeof tools>
    >
    await expect(
      validateUIMessages<SchemaMessage>({ messages: replay, tools })
    ).resolves.toEqual(replay)
    expect(() =>
      withJsonSafeToolOutputs({
        custom: tool({
          inputSchema: z.object({}),
          execute: async () => ({ asOf: new Date() }),
          toModelOutput: ({ output: rawOutput }) => ({
            type: "text",
            value: rawOutput.asOf.toISOString(),
          }),
        }),
      })
    ).toThrowError("Tool custom has a custom toModelOutput hook")
  })

  it("round-trips the production UI SSE protocol through persistence, validation, and replay", async () => {
    const tools = withJsonSafeToolOutputs({
      portfolio_get_summary: tool({
        inputSchema: z.object({}),
        execute: async () => ({ asOf: new Date("2026-08-30T01:02:03.000Z") }),
      }),
    })
    type PortfolioMessage = UIMessage<
      unknown,
      UIDataTypes,
      InferUITools<typeof tools>
    >
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1
        return call === 1
          ? {
              stream: simulateReadableStream({
                chunks: toolCallChunks("portfolio_get_summary", "portfolio-1"),
              }),
            }
          : {
              stream: simulateReadableStream({
                chunks: finalTextChunks("text-replay", "Reviewed."),
              }),
            }
      },
    })
    const result = streamText({
      model,
      prompt: "Review",
      tools,
      stopWhen: isStepCount(3),
    })
    const response = createUIMessageStreamResponse({
      stream: toUIMessageStream<typeof tools, PortfolioMessage>({
        stream: result.stream,
        tools,
        generateMessageId: () => "assistant-1",
      }),
    })
    const sse = await response.text()
    const chunks = sse
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk)
    const chunkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    let completed: PortfolioMessage | undefined
    for await (const snapshot of readUIMessageStream<PortfolioMessage>({
      stream: chunkStream,
    })) {
      completed = snapshot
    }
    const persisted = JSON.parse(JSON.stringify(completed)) as PortfolioMessage
    const validated = await validateUIMessages<PortfolioMessage>({
      messages: [persisted],
      tools,
    })
    const modelMessages = await convertToModelMessages(validated, { tools })

    expect(sse).toContain('"asOf":"2026-08-30T01:02:03.000Z"')
    expect(validated).toEqual([persisted])
    expect(
      modelMessages.every(
        (message) => modelMessageSchema.safeParse(message).success
      )
    ).toBe(true)
    expect(JSON.stringify(modelMessages)).toContain(
      '"asOf":"2026-08-30T01:02:03.000Z"'
    )
  })
})
