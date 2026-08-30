import { z } from "zod"
import type {
  FlexibleSchema,
  InferToolInput,
  JSONValue,
  Tool,
  ToolExecuteFunction,
  ToolExecutionOptions,
  ToolSet,
} from "ai"

type ToolContext<TOOL extends Tool> = TOOL extends Tool<any, any, infer CONTEXT>
  ? CONTEXT
  : unknown

type JsonSafeTool<TOOL extends Tool> = TOOL["execute"] extends (
  ...args: Array<never>
) => unknown
  ? Tool<InferToolInput<TOOL>, JSONValue, ToolContext<TOOL>> &
    Omit<TOOL, keyof Tool> & {
      execute: ToolExecuteFunction<
        InferToolInput<TOOL>,
        JSONValue,
        ToolContext<TOOL>
      >
      outputSchema: FlexibleSchema<JSONValue>
      toModelOutput?: undefined
    }
  : TOOL

export type JsonSafeToolSet<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS]: JsonSafeTool<TOOLS[NAME]>
}

function unsupportedValue(path: string, value: unknown): never {
  const kind =
    typeof value === "object" && value !== null ? "custom object" : typeof value
  throw new TypeError(`Tool output contains unsupported ${kind} at ${path}`)
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  )
}

/**
 * Converts an arbitrary tool result into the exact JSON value contract consumed
 * by the AI SDK and persisted UI-message replay.
 *
 * Undefined and non-finite numbers become null, bigint becomes a decimal string,
 * valid Dates become ISO strings, invalid Dates become null, and cycles throw.
 * Only arrays and plain objects are traversed; custom instances are rejected so
 * getters, enumerable internals, and surprising toJSON implementations cannot leak.
 */
export function normalizeToolOutput(value: unknown): JSONValue {
  const ancestors = new WeakSet<object>()

  const visit = (current: unknown, path: string): JSONValue => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current
    }
    if (typeof current === "number")
      return Number.isFinite(current) ? current : null
    if (typeof current === "bigint") return current.toString(10)
    if (current === undefined) return null
    if (typeof current === "symbol" || typeof current === "function") {
      return unsupportedValue(path, current)
    }
    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? null : current.toISOString()
    }
    if (!Array.isArray(current) && !isPlainObject(current)) {
      return unsupportedValue(path, current)
    }
    if (ancestors.has(current)) {
      throw new TypeError(
        `Tool output contains a circular reference at ${path}`
      )
    }

    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => visit(item, `${path}[${index}]`))
      }

      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [
          key,
          visit(item, `${path}.${key}`),
        ])
      )
    } finally {
      ancestors.delete(current)
    }
  }

  return visit(value, "$")
}

function normalizeAsyncIterable(
  iterable: AsyncIterable<unknown>
): AsyncIterable<JSONValue> {
  return {
    async *[Symbol.asyncIterator]() {
      let yielded = false
      for await (const output of iterable) {
        yielded = true
        yield normalizeToolOutput(output)
      }
      if (!yielded) yield null
    },
  }
}

function replacementDescriptor(
  descriptor: PropertyDescriptor | undefined,
  value: unknown
): PropertyDescriptor {
  return {
    value,
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    writable: "writable" in (descriptor ?? {}) ? descriptor?.writable : true,
  }
}

function cloneToolWithOverrides(
  definition: Tool,
  overrides: Record<string, unknown>
): Tool {
  const descriptors = Object.getOwnPropertyDescriptors(definition)
  for (const [key, value] of Object.entries(overrides)) {
    descriptors[key] = replacementDescriptor(descriptors[key], value)
  }
  return Object.create(Object.getPrototypeOf(definition), descriptors) as Tool
}

/** Wrap every executable server tool once at the AI SDK boundary. */
export function withJsonSafeToolOutputs<const TOOLS extends ToolSet>(
  tools: TOOLS
): JsonSafeToolSet<TOOLS> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute
      if (typeof execute !== "function") return [name, definition]
      if (definition.toModelOutput) {
        throw new TypeError(
          `Tool ${name} has a custom toModelOutput hook that cannot safely follow output normalization`
        )
      }

      return [
        name,
        cloneToolWithOverrides(definition, {
          // The original schema describes pre-normalized values (for example Date).
          // Replay validates the actual persisted contract instead: any JSON value.
          outputSchema: z.json(),
          toModelOutput: undefined,
          execute: (input: unknown, options: ToolExecutionOptions<unknown>) => {
            const output = (
              execute as (
                input: unknown,
                options: ToolExecutionOptions<unknown>
              ) => unknown
            )(input, options)
            if (isAsyncIterable(output)) return normalizeAsyncIterable(output)
            return Promise.resolve(output).then(normalizeToolOutput)
          },
        }),
      ]
    })
  ) as JsonSafeToolSet<TOOLS>
}
