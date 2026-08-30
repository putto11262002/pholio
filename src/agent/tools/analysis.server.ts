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

const artifactScalarSchema = z.union([z.string(), z.number(), z.null()])
const artifactKeySchema = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(60)
const artifactTitleSchema = z.string().trim().min(1).max(120)
const artifactCaptionSchema = z.string().trim().max(240).optional()
const artifactToneSchema = z.enum(["default", "positive", "negative", "warning"]).optional()

const metricGridArtifactSchema = z.object({
  type: z.literal("metric_grid"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  items: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.union([z.string(), z.number()]),
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
    value: z.number(),
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
type AnalysisProgressPhase = "provisioning" | "uploading" | "running" | "reading"

export type AnalysisProgressReporter = (event: {
  toolCallId: string
  phase: AnalysisProgressPhase
}) => void

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

  const result = analysisOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(z.prettifyError(result.error))
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
  abortSignal?: AbortSignal,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new AgentToolError(message, "terminal", "analysis_run_code", phase))
    }, timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    if (!abortSignal) return
    onAbort = () => reject(abortSignal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener("abort", onAbort, { once: true })
  })

  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort)
  }
}

export function createAnalysisTools(userId: string, reportProgress?: AnalysisProgressReporter) {
  return {
  analysis_run_code: tool({
    description:
      "Run bounded Python analysis over portfolio and market data. Use for calculations over price history, technical indicators, drawdown, volatility, concentration, comparisons, and other numerical work. Python should import pholio_sdk as pholio and finish with pholio.output.write(summary, result, artifacts=...). The summary must be one short sentence describing what was done. Optional artifacts can include metric_grid, table, line_chart, area_chart, bar_chart, donut_chart, event_timeline, or callout payloads for UI rendering. Do not use for trade execution or portfolio writes.",
    inputSchema: runAnalysisInput,
    execute: async ({ task, code }, { abortSignal, toolCallId }) => {
      const runId = crypto.randomUUID()
      const startedAt = Date.now()
      let phase: AnalysisPhase = "sandbox_io"
      try {
        abortSignal?.throwIfAborted()
        logAnalysis("start", {
          runId,
          task,
          codeLength: code.length,
          execTimeoutMs: EXEC_TIMEOUT_MS,
          sandboxIoTimeoutMs: SANDBOX_IO_TIMEOUT_MS,
          sandboxStartupTimeoutMs: SANDBOX_PORT_READY_TIMEOUT_MS,
        })

        reportProgress?.({ toolCallId, phase: "provisioning" })

        const apiToken = await createUserApiToken(userId)
        abortSignal?.throwIfAborted()

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
        reportProgress?.({ toolCallId, phase: "uploading" })
        await withTimeout(
          sandbox.writeFile("/workspace/run_analysis.py", code),
          SANDBOX_IO_TIMEOUT_MS,
          `Timed out writing analysis code after ${SANDBOX_IO_TIMEOUT_MS}ms`,
          "sandbox_io",
          undefined,
          abortSignal,
        )
        logAnalysis("files_written", {
          runId,
          codeBytes: byteLength(code),
        })

        phase = "exec"
        reportProgress?.({ toolCallId, phase: "running" })
        const result = await withTimeout(
          sandbox.exec("python3 /workspace/run_analysis.py", {
            cwd: "/workspace",
            timeout: EXEC_TIMEOUT_MS,
            env: {
              PYTHONPATH: "/workspace",
              PHOLIO_API_BASE_URL: env.PHOLIO_API_BASE_URL,
              PHOLIO_API_TOKEN: apiToken,
            },
            signal: abortSignal,
          }),
          EXEC_TIMEOUT_MS + 2_000,
          `Python execution timed out after ${EXEC_TIMEOUT_MS}ms`,
          "exec",
          undefined,
          abortSignal,
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
        reportProgress?.({ toolCallId, phase: "reading" })
        const output = await withTimeout(
          sandbox.readFile("/workspace/output.json"),
          SANDBOX_IO_TIMEOUT_MS,
          `Timed out reading analysis output after ${SANDBOX_IO_TIMEOUT_MS}ms`,
          "output",
          undefined,
          abortSignal,
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
        if (abortSignal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          logAnalysis("cancelled", {
            runId,
            phase,
            durationMs: Date.now() - startedAt,
          })
          throw err
        }
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
