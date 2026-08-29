import { getSandbox } from "@cloudflare/sandbox"
import { tool } from "ai"
import { env } from "cloudflare:workers"
import { z } from "zod"
import { createUserApiToken } from "@/auth/api-token.server"
import { AgentToolError } from "./errors.server"
import type { AnalysisSandbox } from "@/agent/runtime/analysis-sandbox.server"

const EXEC_TIMEOUT_MS = 15_000
const SANDBOX_IO_TIMEOUT_MS = 20_000
const SANDBOX_INSTANCE_TIMEOUT_MS = 5_000
const SANDBOX_PORT_READY_TIMEOUT_MS = 12_000
const SANDBOX_POLL_INTERVAL_MS = 500
const MAX_OUTPUT_BYTES = 256_000
const MAX_RESULT_BYTES = 128_000
const MAX_ARTIFACT_BYTES = 128_000
const MAX_ARTIFACTS = 4
const MAX_METRIC_ITEMS = 12
const MAX_CHART_POINTS = 200
const MAX_TABLE_ROWS = 50
const MAX_TABLE_COLUMNS = 8
const MAX_DONUT_SEGMENTS = 12
const MAX_TIMELINE_EVENTS = 12

const runAnalysisInput = z.object({
  task: z.string().min(1).max(1_000),
  code: z.string().min(1).max(12_000).describe(
    "Python code. It must import pholio_sdk as pholio, fetch data through its API-backed accessors, and write output with pholio.output.write(summary, result).",
  ),
})

const artifactScalarSchema = z.union([z.string(), z.number().finite(), z.null()])
const artifactKeySchema = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(60)
const artifactTitleSchema = z.string().trim().min(1).max(120)
const artifactCaptionSchema = z.string().trim().max(240).optional()
const artifactToneSchema = z.enum(["default", "positive", "negative", "warning"]).optional()
const artifactTones = new Set(["default", "positive", "negative", "warning"])

const metricGridArtifactSchema = z.object({
  type: z.literal("metric_grid"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  items: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.union([z.string(), z.number().finite()]),
    unit: z.string().trim().max(24).optional(),
    tone: artifactToneSchema,
  })).min(1).max(MAX_METRIC_ITEMS),
})

const chartSeriesSchema = z.object({
  key: artifactKeySchema,
  label: z.string().trim().min(1).max(80),
})

function xyChartArtifactSchema<T extends "line_chart" | "area_chart" | "bar_chart">(type: T) {
  return z.object({
    type: z.literal(type),
    id: z.string().trim().min(1).max(80),
    title: artifactTitleSchema,
    caption: artifactCaptionSchema,
    xKey: artifactKeySchema,
    series: z.array(chartSeriesSchema).min(1).max(5),
    data: z.array(z.record(z.string(), artifactScalarSchema)).min(1).max(MAX_CHART_POINTS),
    ...(type === "area_chart" ? { stacked: z.boolean().optional() } : {}),
  })
}

const lineChartArtifactSchema = xyChartArtifactSchema("line_chart")
const areaChartArtifactSchema = xyChartArtifactSchema("area_chart")
const barChartArtifactSchema = xyChartArtifactSchema("bar_chart")

const donutChartArtifactSchema = z.object({
  type: z.literal("donut_chart"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  segments: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.number().finite(),
  })).min(1).max(MAX_DONUT_SEGMENTS),
})

const tableArtifactSchema = z.object({
  type: z.literal("table"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  columns: z.array(z.object({
    key: artifactKeySchema,
    label: z.string().trim().min(1).max(80),
  })).min(1).max(MAX_TABLE_COLUMNS),
  rows: z.array(z.record(z.string(), artifactScalarSchema)).max(MAX_TABLE_ROWS),
})

const timelineArtifactSchema = z.object({
  type: z.literal("event_timeline"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  events: z.array(z.object({
    date: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(240).optional(),
    tone: artifactToneSchema,
    url: z.string().trim().url().max(500).optional(),
  })).min(1).max(MAX_TIMELINE_EVENTS),
})

const calloutArtifactSchema = z.object({
  type: z.literal("callout"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  body: z.string().trim().min(1).max(500),
  tone: artifactToneSchema,
})

const analysisArtifactSchema = z.discriminatedUnion("type", [
  metricGridArtifactSchema,
  lineChartArtifactSchema,
  areaChartArtifactSchema,
  barChartArtifactSchema,
  donutChartArtifactSchema,
  tableArtifactSchema,
  timelineArtifactSchema,
  calloutArtifactSchema,
])

const analysisOutputSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  result: z.unknown(),
  artifacts: z.array(analysisArtifactSchema).max(MAX_ARTIFACTS).optional(),
})

type AnalysisPhase = "sandbox_io" | "exec" | "output"

function logAnalysis(event: string, data: Record<string, unknown>) {
  console.info(JSON.stringify({
    event: `agent.analysis.${event}`,
    ...data,
  }))
}

function parseAnalysisOutput(content: string): z.infer<typeof analysisOutputSchema> {
  const outputBytes = byteLength(content)
  if (outputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Analysis output cannot exceed ${MAX_OUTPUT_BYTES} bytes`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error("Analysis output must be valid JSON")
  }

  const normalized = normalizeAnalysisOutput(parsed)
  const result = analysisOutputSchema.safeParse(normalized)
  if (!result.success) {
    throw new Error(formatValidationError(result.error))
  }

  const resultBytes = byteLength(JSON.stringify(result.data.result))
  if (resultBytes > MAX_RESULT_BYTES) {
    throw new Error(`Analysis result cannot exceed ${MAX_RESULT_BYTES} bytes`)
  }

  const artifactBytes = byteLength(JSON.stringify(result.data.artifacts ?? []))
  if (artifactBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Analysis artifacts cannot exceed ${MAX_ARTIFACT_BYTES} bytes`)
  }

  return result.data
}

function formatValidationError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "output"
    return `${path}: ${issue.message}`
  })
  const suffix = error.issues.length > issues.length ? ` (${error.issues.length - issues.length} more)` : ""
  return `Analysis output shape is invalid: ${issues.join("; ")}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function normalizedTone(value: unknown): string {
  return typeof value === "string" && artifactTones.has(value) ? value : "default"
}

function normalizeMetricItem(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    label: firstString(value, ["label", "name", "metric"]) ?? value.label,
    tone: normalizedTone(value.tone),
  }
}

function normalizeSeries(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    label: firstString(value, ["label", "name"]) ?? firstString(value, ["key"]) ?? value.label,
  }
}

function normalizeColumn(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    label: firstString(value, ["label", "name"]) ?? firstString(value, ["key"]) ?? value.label,
  }
}

function normalizeSegment(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    label: firstString(value, ["label", "name"]) ?? value.label,
  }
}

function normalizeTimelineEvent(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    tone: normalizedTone(value.tone),
  }
}

function normalizeArtifact(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return value

  if (value.type === "metric_grid" && Array.isArray(value.items)) {
    return { ...value, items: value.items.map(normalizeMetricItem) }
  }

  if ((value.type === "line_chart" || value.type === "area_chart" || value.type === "bar_chart") && Array.isArray(value.series)) {
    return { ...value, series: value.series.map(normalizeSeries) }
  }

  if (value.type === "donut_chart" && Array.isArray(value.segments)) {
    return { ...value, segments: value.segments.map(normalizeSegment) }
  }

  if (value.type === "table" && Array.isArray(value.columns)) {
    return { ...value, columns: value.columns.map(normalizeColumn) }
  }

  if (value.type === "event_timeline" && Array.isArray(value.events)) {
    return { ...value, events: value.events.map(normalizeTimelineEvent) }
  }

  if (value.type === "callout") {
    return {
      ...value,
      body: firstString(value, ["body", "description"]) ?? value.body,
      tone: normalizedTone(value.tone),
    }
  }

  return value
}

function normalizeAnalysisOutput(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(normalizeArtifact) : value.artifacts,
  }
}

function sandboxId(): string {
  return `analysis-${crypto.randomUUID()}`
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function clip(value: string, max = 4_000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  phase: AnalysisPhase,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new AgentToolError(message, "terminal", "analysis_run_code", phase))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export function createAnalysisTools(userId: string) {
  return {
  analysis_run_code: tool({
    description:
      "Run bounded Python analysis over portfolio and market data. Use for calculations over price history, technical indicators, drawdown, volatility, concentration, comparisons, and other numerical work. Python should import pholio_sdk as pholio and finish with pholio.output.write(summary, result, artifacts=...). The summary must be one short sentence describing what was done. Optional artifacts can include metric_grid, table, line_chart, area_chart, bar_chart, donut_chart, event_timeline, or callout payloads for UI rendering. Do not use for trade execution or portfolio writes.",
    inputSchema: runAnalysisInput,
    execute: async ({ task, code }) => {
      const runId = crypto.randomUUID()
      const startedAt = Date.now()
      let phase: AnalysisPhase = "sandbox_io"
      try {
        logAnalysis("start", {
          runId,
          task,
          codeLength: code.length,
          execTimeoutMs: EXEC_TIMEOUT_MS,
          sandboxIoTimeoutMs: SANDBOX_IO_TIMEOUT_MS,
          sandboxStartupTimeoutMs: SANDBOX_PORT_READY_TIMEOUT_MS,
        })

        const apiToken = await createUserApiToken(userId)

        const sandbox = getSandbox<AnalysisSandbox>(
          env.ANALYSIS_SANDBOX,
          sandboxId(),
          {
            keepAlive: false,
            containerTimeouts: {
              instanceGetTimeoutMS: SANDBOX_INSTANCE_TIMEOUT_MS,
              portReadyTimeoutMS: SANDBOX_PORT_READY_TIMEOUT_MS,
              waitIntervalMS: SANDBOX_POLL_INTERVAL_MS,
            },
          },
        )

        phase = "sandbox_io"
        await withTimeout(
          sandbox.writeFile("/workspace/run_analysis.py", code),
          SANDBOX_IO_TIMEOUT_MS,
          `Timed out writing analysis code after ${SANDBOX_IO_TIMEOUT_MS}ms`,
          "sandbox_io",
        )
        logAnalysis("files_written", {
          runId,
          codeBytes: byteLength(code),
        })

        phase = "exec"
        const result = await withTimeout(
          sandbox.exec("python3 /workspace/run_analysis.py", {
            cwd: "/workspace",
            timeout: EXEC_TIMEOUT_MS,
            env: {
              PYTHONPATH: "/workspace",
              PHOLIO_API_BASE_URL: env.PHOLIO_API_BASE_URL,
              PHOLIO_API_TOKEN: apiToken,
            },
          }),
          EXEC_TIMEOUT_MS + 2_000,
          `Python execution timed out after ${EXEC_TIMEOUT_MS}ms`,
          "exec",
        )
        logAnalysis("exec_finished", {
          runId,
          success: result.success,
          exitCode: result.exitCode,
          durationMs: result.duration,
          stdoutBytes: byteLength(result.stdout),
          stderrBytes: byteLength(result.stderr),
        })

        if (!result.success) {
          const error = result.stderr.trim() || result.stdout.trim() || "Python execution failed"
          throw new AgentToolError(`Python execution failed. ${clip(error)}`, "recoverable", "analysis_run_code", "exec", {
            exitCode: result.exitCode,
            stdout: clip(result.stdout),
            stderr: clip(result.stderr),
            error: clip(error),
          })
        }

        phase = "output"
        const output = await withTimeout(
          sandbox.readFile("/workspace/output.json"),
          SANDBOX_IO_TIMEOUT_MS,
          `Timed out reading analysis output after ${SANDBOX_IO_TIMEOUT_MS}ms`,
          "output",
        )
        const parsed = parseAnalysisOutput(output.content)
        logAnalysis("output_valid", {
          runId,
          outputBytes: byteLength(output.content),
          summary: parsed.summary,
        })

        logAnalysis("finish", {
          runId,
          durationMs: Date.now() - startedAt,
          execDurationMs: result.duration,
          status: "success",
        })
        return {
          success: true,
          runId,
          durationMs: result.duration,
          summary: parsed.summary,
          result: parsed.result,
          artifacts: parsed.artifacts ?? [],
          stdout: clip(result.stdout, 2_000),
          stderr: clip(result.stderr, 2_000),
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const failurePhase = err instanceof AgentToolError ? err.phase ?? phase : phase
        const details = err instanceof AgentToolError ? err.details : undefined
        const mode = err instanceof AgentToolError ? err.mode : terminalModeForPhase(failurePhase)
        logAnalysis("failed", {
          runId,
          phase: failurePhase,
          mode,
          durationMs: Date.now() - startedAt,
          error: clip(error, 1_000),
          details,
        })
        if (err instanceof AgentToolError) {
          throw err
        }
        throw new AgentToolError(error, mode, "analysis_run_code", failurePhase)
      }
    },
  }),
  }
}

function terminalModeForPhase(phase: AnalysisPhase | string): "recoverable" | "terminal" {
  return phase === "output" ? "recoverable" : "terminal"
}
