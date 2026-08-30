import {
  ContainerUnavailableError,
  OperationInterruptedError,
  ProcessAbortedError,
  ProcessWaitTimeoutError,
  RPCTransportError,
  RuntimeControlProtocolError,
  getSandbox,
} from "@cloudflare/sandbox"
import { tool } from "ai"
import { env } from "cloudflare:workers"
import { z } from "zod"
import { AgentToolError, sanitizeToolErrorMessage } from "./errors.server"
import type { SandboxProcess } from "@cloudflare/sandbox"
import type { AnalysisSandbox } from "@/agent/runtime/analysis-sandbox.server"
import { createUserApiToken } from "@/auth/api-token.server"

const EXEC_LOCAL_TIMEOUT_MS = 15_000
const EXEC_REMOTE_TIMEOUT_MS = 17_000
const PROCESS_STOP_TIMEOUT_MS = 2_000
const PROCESS_ACTION_TIMEOUT_MS = 500
const CLEANUP_TIMEOUT_MS = 3_000
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
  code: z
    .string()
    .min(1)
    .max(12_000)
    .describe(
      "Python code. It must import pholio_sdk as pholio, fetch data through its API-backed accessors, and write output with pholio.output.write(summary, result)."
    ),
})

const artifactScalarSchema = z.union([z.string(), z.number(), z.null()])
const artifactKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(60)
const artifactTitleSchema = z.string().trim().min(1).max(120)
const artifactCaptionSchema = z.string().trim().max(240).optional()
const artifactToneSchema = z
  .enum(["default", "positive", "negative", "warning"])
  .optional()

const metricGridArtifactSchema = z.object({
  type: z.literal("metric_grid"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        value: z.union([z.string(), z.number()]),
        unit: z.string().trim().max(24).optional(),
        tone: artifactToneSchema,
      })
    )
    .min(1)
    .max(MAX_METRIC_ITEMS),
})

const chartSeriesSchema = z.object({
  key: artifactKeySchema,
  label: z.string().trim().min(1).max(80),
})

function xyChartArtifactSchema<
  T extends "line_chart" | "area_chart" | "bar_chart",
>(type: T) {
  return z.object({
    type: z.literal(type),
    id: z.string().trim().min(1).max(80),
    title: artifactTitleSchema,
    caption: artifactCaptionSchema,
    xKey: artifactKeySchema,
    series: z.array(chartSeriesSchema).min(1).max(5),
    data: z
      .array(z.record(z.string(), artifactScalarSchema))
      .min(1)
      .max(MAX_CHART_POINTS),
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
  segments: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        value: z.number(),
      })
    )
    .min(1)
    .max(MAX_DONUT_SEGMENTS),
})

const tableArtifactSchema = z.object({
  type: z.literal("table"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  columns: z
    .array(
      z.object({
        key: artifactKeySchema,
        label: z.string().trim().min(1).max(80),
      })
    )
    .min(1)
    .max(MAX_TABLE_COLUMNS),
  rows: z.array(z.record(z.string(), artifactScalarSchema)).max(MAX_TABLE_ROWS),
})

const timelineArtifactSchema = z.object({
  type: z.literal("event_timeline"),
  id: z.string().trim().min(1).max(80),
  title: artifactTitleSchema,
  caption: artifactCaptionSchema,
  events: z
    .array(
      z.object({
        date: z.string().trim().min(1).max(40),
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(240).optional(),
        tone: artifactToneSchema,
        url: z.string().trim().url().max(500).optional(),
      })
    )
    .min(1)
    .max(MAX_TIMELINE_EVENTS),
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
type AnalysisProgressPhase =
  | "provisioning"
  | "uploading"
  | "running"
  | "reading"

export type AnalysisProgressReporter = (event: {
  toolCallId: string
  phase: AnalysisProgressPhase
}) => void

export type AnalysisTaskDefer = (task: Promise<void>) => void

function logAnalysis(event: string, data: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      event: `agent.analysis.${event}`,
      ...data,
    })
  )
}

function parseAnalysisOutput(
  content: string
): z.infer<typeof analysisOutputSchema> {
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
    throw new Error(
      `Analysis artifacts cannot exceed ${MAX_ARTIFACT_BYTES} bytes`
    )
  }

  return result.data
}

async function sandboxId(userId: string, conversationId: string): Promise<string> {
  const identity = JSON.stringify([userId, conversationId])
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity)
  )
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `analysis-${hash.slice(0, 52)}`
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function clip(value: string, max = 4_000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  phase: AnalysisPhase,
  abortSignal?: AbortSignal
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new AgentToolError(
          message,
          phase === "sandbox_io" ? "terminal" : "recoverable",
          "analysis_run_code",
          phase
        )
      )
    }, timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    if (!abortSignal) return
    onAbort = () =>
      reject(
        abortSignal.reason ??
          new DOMException("The operation was aborted", "AbortError")
      )
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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const settled = promise.then(
    (value) => ({ settled: true as const, value }),
    () => ({ settled: false as const })
  )
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ settled: false }), timeoutMs)
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function killAndReap(process: SandboxProcess): Promise<void> {
  const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS
  const remaining = () => Math.max(0, deadline - Date.now())
  const bounded = (promise: Promise<unknown>) =>
    settleWithin(promise, Math.min(PROCESS_ACTION_TIMEOUT_MS, remaining()))

  await bounded(process.kill(9))
  if (remaining() === 0) return
  const firstWait = await bounded(
    process.waitForExit({ timeout: Math.min(PROCESS_ACTION_TIMEOUT_MS, remaining()) })
  )
  if (firstWait.settled || remaining() === 0) return

  await bounded(process.kill(9))
  if (remaining() === 0) return
  await bounded(
    process.waitForExit({ timeout: Math.min(PROCESS_ACTION_TIMEOUT_MS, remaining()) })
  )
}

async function outputOrStop(
  process: SandboxProcess,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  phase: AnalysisPhase
) {
  try {
    return await waitWithTimeout(
      process.output({
        encoding: "utf8",
        maxBytes: MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        signal: abortSignal,
      }),
      timeoutMs,
      `Analysis process output timed out after ${timeoutMs}ms`,
      phase,
      abortSignal
    )
  } catch (error) {
    await killAndReap(process)
    throw error
  }
}

function executionDiagnostic(stdout: string, stderr: string): string | undefined {
  const diagnostic = sanitizeToolErrorMessage(stderr.trim() || stdout.trim())
  return diagnostic === "The tool failed without a usable error message."
    ? undefined
    : diagnostic
}

function boundedRetryAfterMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 24 * 60 * 60 * 1_000)
    : undefined
}

function safeSandboxError(
  error: unknown,
  phase: AnalysisPhase
): AgentToolError | undefined {
  if (error instanceof ContainerUnavailableError) {
    const retryAfterMs = boundedRetryAfterMs(error.context.retryAfterMs)
    return new AgentToolError(
      "Analysis capacity is temporarily unavailable.",
      "recoverable",
      "analysis_run_code",
      phase,
      {
        category: "capacity",
        code: error.code,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    )
  }
  if (error instanceof OperationInterruptedError) {
    return new AgentToolError(
      "The analysis workspace was interrupted.",
      error.retryable ? "recoverable" : "terminal",
      "analysis_run_code",
      phase,
      {
        category: "interrupted",
        code: error.code,
        reason: error.reason,
        retryable: error.retryable,
      }
    )
  }
  if (error instanceof RPCTransportError) {
    return new AgentToolError(
      "The analysis workspace connection was interrupted.",
      "recoverable",
      "analysis_run_code",
      phase,
      { category: "rpc", code: error.code, kind: error.kind }
    )
  }
  if (error instanceof RuntimeControlProtocolError) {
    return new AgentToolError(
      "The analysis runtime is temporarily unavailable.",
      "terminal",
      "analysis_run_code",
      phase,
      { category: "protocol", code: error.code }
    )
  }
  if (error instanceof ProcessWaitTimeoutError) {
    return new AgentToolError(
      "Analysis execution exceeded its local wait limit.",
      "recoverable",
      "analysis_run_code",
      phase,
      { category: "timeout", code: error.code }
    )
  }
  if (error instanceof ProcessAbortedError) {
    return new AgentToolError(
      "Analysis execution was cancelled.",
      "recoverable",
      "analysis_run_code",
      phase,
      { category: "aborted", code: error.code }
    )
  }
  return undefined
}

function errorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof AgentToolError) {
    return { errorName: error.name, mode: error.mode, phase: error.phase }
  }
  if (error instanceof Error) return { errorName: error.name }
  return { errorName: "UnknownError" }
}

async function superviseCommand({
  launch,
  abortSignal,
  localTimeoutMs,
  phase,
  defer,
  onLateProcess,
  runId,
}: {
  launch: Promise<SandboxProcess>
  abortSignal?: AbortSignal
  localTimeoutMs: number
  phase: AnalysisPhase
  defer?: AnalysisTaskDefer
  onLateProcess?: () => Promise<void>
  runId: string
}) {
  let process: SandboxProcess
  try {
    process = await waitWithTimeout(
      launch,
      localTimeoutMs,
      `Analysis process launch timed out after ${localTimeoutMs}ms`,
      phase,
      abortSignal
    )
  } catch (originalError) {
    // A launch may have been admitted after the local caller stopped waiting.
    // If a handle becomes available, force-stop and reap it before preserving the
    // original timeout or abort.
    if (defer) {
      defer((async () => {
        try {
          const lateProcess = await launch
          await killAndReap(lateProcess)
          await onLateProcess?.()
          logAnalysis("background_late_launch", {
            runId,
            status: "cleaned",
            phase,
          })
        } catch (error) {
          logAnalysis("background_late_launch", {
            runId,
            status: "failed",
            phase,
            ...errorMetadata(error),
          })
        }
      })())
    } else {
      const observed = await settleWithin(launch, PROCESS_STOP_TIMEOUT_MS)
      if (observed.settled) {
        await killAndReap(observed.value)
      }
    }
    throw originalError
  }
  return process
}

async function cleanupRun(
  sandbox: ReturnType<typeof getSandbox<AnalysisSandbox>>,
  runDirectory: string,
  runId: string,
  defer?: AnalysisTaskDefer
) {
  return waitWithTimeout(
    (async () => {
      const cleanup = await superviseCommand({
        launch: sandbox.exec(["rm", "-rf", "--", runDirectory], {
          timeout: CLEANUP_TIMEOUT_MS,
        }),
        localTimeoutMs: CLEANUP_TIMEOUT_MS,
        phase: "sandbox_io",
        defer,
        runId,
      })
      return outputOrStop(
        cleanup,
        undefined,
        CLEANUP_TIMEOUT_MS,
        "sandbox_io"
      )
    })(),
    CLEANUP_TIMEOUT_MS,
    `Analysis cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms`,
    "sandbox_io"
  )
}

export function createAnalysisTools(
  userId: string,
  conversationId: string,
  reportProgress?: AnalysisProgressReporter,
  defer?: AnalysisTaskDefer
) {
  return {
    analysis_run_code: tool({
      description:
        "Run bounded Python analysis over portfolio and market data. Use for calculations over price history, technical indicators, drawdown, volatility, concentration, comparisons, and other numerical work. Python should import pholio_sdk as pholio and finish with pholio.output.write(summary, result, artifacts=...). The summary must be one short sentence describing what was done. Optional artifacts can include metric_grid, table, line_chart, area_chart, bar_chart, donut_chart, event_timeline, or callout payloads for UI rendering. Do not use for trade execution or portfolio writes.",
      inputSchema: runAnalysisInput,
      execute: async ({ code }, { abortSignal, toolCallId }) => {
        const runId = crypto.randomUUID()
        const startedAt = Date.now()
        let phase: AnalysisPhase = "sandbox_io"
        let sandbox: ReturnType<typeof getSandbox<AnalysisSandbox>> | undefined
        let uploadOperation: Promise<unknown> | undefined
        let uploadCompletion: Promise<void> | undefined
        let uploadSettled = true
        let primaryError: unknown
        try {
          abortSignal?.throwIfAborted()
          const runDirectory = `/workspace/runs/${runId}`
          const scriptPath = `${runDirectory}/run_analysis.py`
          const outputPath = `${runDirectory}/output.json`
          logAnalysis("start", {
            runId,
            execTimeoutMs: EXEC_REMOTE_TIMEOUT_MS,
            localOutputTimeoutMs: EXEC_LOCAL_TIMEOUT_MS,
            sandboxIoTimeoutMs: SANDBOX_IO_TIMEOUT_MS,
            sandboxStartupTimeoutMs: SANDBOX_PORT_READY_TIMEOUT_MS,
          })

          reportProgress?.({ toolCallId, phase: "provisioning" })

          const apiToken = await createUserApiToken(userId)
          abortSignal?.throwIfAborted()

          sandbox = getSandbox<AnalysisSandbox>(
            env.ANALYSIS_SANDBOX,
            await sandboxId(userId, conversationId),
            {
              keepAlive: false,
              normalizeId: true,
              containerTimeouts: {
                instanceGetTimeoutMS: SANDBOX_INSTANCE_TIMEOUT_MS,
                portReadyTimeoutMS: SANDBOX_PORT_READY_TIMEOUT_MS,
                waitIntervalMS: SANDBOX_POLL_INTERVAL_MS,
              },
            }
          )

          const cleanupLateRun = async () => {
            try {
              const result = await cleanupRun(sandbox!, runDirectory, runId, defer)
              if (result.timedOut || result.truncated || result.exitCode !== 0) {
                throw new AgentToolError(
                  "Deferred analysis cleanup failed.",
                  "terminal",
                  "analysis_run_code",
                  "sandbox_io"
                )
              }
            } catch (error) {
              logAnalysis("background_cleanup", {
                runId,
                status: "failed",
                ...errorMetadata(error),
              })
              throw error
            }
          }

          const mkdirProcess = await superviseCommand({
            launch: sandbox.exec(["mkdir", "-p", "--", runDirectory], {
              timeout: SANDBOX_IO_TIMEOUT_MS,
            }),
            abortSignal,
            localTimeoutMs: SANDBOX_IO_TIMEOUT_MS,
            phase: "sandbox_io",
            defer,
            onLateProcess: cleanupLateRun,
            runId,
          })
          const mkdirResult = await outputOrStop(
            mkdirProcess,
            abortSignal,
            SANDBOX_IO_TIMEOUT_MS,
            "sandbox_io"
          )
          if (mkdirResult.timedOut || mkdirResult.exitCode !== 0) {
            throw new AgentToolError(
              "Could not prepare the analysis workspace.",
              "terminal",
              "analysis_run_code",
              "sandbox_io",
              {
                category: mkdirResult.timedOut ? "timeout" : "exit",
                exitCode: mkdirResult.exitCode,
              }
            )
          }

          phase = "sandbox_io"
          reportProgress?.({ toolCallId, phase: "uploading" })
          uploadSettled = false
          uploadOperation = sandbox.writeFile(scriptPath, code)
          uploadCompletion = uploadOperation.then(
            () => { uploadSettled = true },
            () => { uploadSettled = true }
          )
          await waitWithTimeout(
            uploadOperation,
            SANDBOX_IO_TIMEOUT_MS,
            `Timed out writing analysis code after ${SANDBOX_IO_TIMEOUT_MS}ms`,
            "sandbox_io",
            abortSignal
          )
          logAnalysis("files_written", {
            runId,
            status: "success",
          })

          phase = "exec"
          reportProgress?.({ toolCallId, phase: "running" })
          const process = await superviseCommand({
            launch: sandbox.exec(["python3", scriptPath], {
              cwd: runDirectory,
              timeout: EXEC_REMOTE_TIMEOUT_MS,
              env: {
                PYTHONPATH: "/workspace",
                PHOLIO_API_BASE_URL: env.PHOLIO_API_BASE_URL,
                PHOLIO_API_TOKEN: apiToken,
                PHOLIO_OUTPUT_PATH: outputPath,
              },
            }),
            localTimeoutMs: EXEC_LOCAL_TIMEOUT_MS,
            abortSignal,
            phase: "exec",
            defer,
            onLateProcess: cleanupLateRun,
            runId,
          })
          const execStartedAt = Date.now()
          const result = await outputOrStop(
            process,
            abortSignal,
            EXEC_LOCAL_TIMEOUT_MS,
            "exec"
          )
          const execDurationMs = Date.now() - execStartedAt
          logAnalysis("exec_finished", {
            runId,
            exitCode: result.exitCode,
            durationMs: execDurationMs,
            timedOut: result.timedOut,
            truncated: result.truncated,
          })

          if (result.timedOut) {
            throw new AgentToolError(
              "Python execution reached its time limit.",
              "recoverable",
              "analysis_run_code",
              "exec",
              {
                category: "timeout",
                exitCode: result.exitCode,
              }
            )
          }
          if (result.truncated) {
            throw new AgentToolError(
              "Python execution output exceeded the allowed size.",
              "recoverable",
              "analysis_run_code",
              "exec",
              {
                category: "truncated",
                exitCode: result.exitCode,
              }
            )
          }
          if (result.exitCode !== 0) {
            const diagnostic = executionDiagnostic(result.stdout, result.stderr)
            throw new AgentToolError(
              `Python execution exited with code ${result.exitCode}.${diagnostic ? ` ${diagnostic}` : ""}`,
              "recoverable",
              "analysis_run_code",
              "exec",
              {
                category: "exit",
                exitCode: result.exitCode,
              }
            )
          }

          phase = "output"
          reportProgress?.({ toolCallId, phase: "reading" })
          const output = await waitWithTimeout(
            sandbox.readFile(outputPath),
            SANDBOX_IO_TIMEOUT_MS,
            `Timed out reading analysis output after ${SANDBOX_IO_TIMEOUT_MS}ms`,
            "output",
            abortSignal
          )
          let parsed: z.infer<typeof analysisOutputSchema>
          try {
            parsed = parseAnalysisOutput(output.content)
          } catch (error) {
            throw new AgentToolError(
              `Analysis output was invalid: ${sanitizeToolErrorMessage(error)}`,
              "recoverable",
              "analysis_run_code",
              "output",
              { category: "invalid_output" }
            )
          }
          logAnalysis("output_valid", {
            runId,
            status: "success",
          })

          logAnalysis("finish", {
            runId,
            durationMs: Date.now() - startedAt,
            execDurationMs,
            status: "success",
          })
          return {
            success: true,
            runId,
            durationMs: execDurationMs,
            summary: parsed.summary,
            result: parsed.result,
            artifacts: parsed.artifacts ?? [],
            stdout: clip(result.stdout, 2_000),
            stderr: clip(result.stderr, 2_000),
          }
        } catch (err) {
          primaryError = err
          if (
            abortSignal?.aborted ||
            (err instanceof DOMException && err.name === "AbortError")
          ) {
            logAnalysis("cancelled", {
              runId,
              phase,
              durationMs: Date.now() - startedAt,
            })
            throw err
          }
          const failurePhase =
            err instanceof AgentToolError ? (err.phase ?? phase) : phase
          const mapped = safeSandboxError(err, failurePhase as AnalysisPhase)
          const reportedError = mapped ?? err
          const mode =
            reportedError instanceof AgentToolError
              ? reportedError.mode
              : terminalModeForPhase(failurePhase)
          logAnalysis("failed", {
            runId,
            phase: failurePhase,
            mode,
            durationMs: Date.now() - startedAt,
            ...errorMetadata(reportedError),
          })
          if (reportedError instanceof AgentToolError) {
            throw reportedError
          }
          throw new AgentToolError(
            "The analysis tool could not complete this run.",
            mode,
            "analysis_run_code",
            failurePhase
          )
        } finally {
          if (sandbox) {
            const cleanupStartedAt = Date.now()
            if (uploadOperation && uploadCompletion && !uploadSettled && defer) {
              defer((async () => {
                await uploadCompletion
                try {
                  const result = await cleanupRun(sandbox!, `/workspace/runs/${runId}`, runId, defer)
                  logAnalysis("background_upload_cleanup", {
                    runId,
                    status:
                      !result.timedOut && !result.truncated && result.exitCode === 0
                        ? "cleaned"
                        : "failed",
                    exitCode: result.exitCode,
                    timedOut: result.timedOut,
                    truncated: result.truncated,
                  })
                } catch (error) {
                  logAnalysis("background_upload_cleanup", {
                    runId,
                    status: "failed",
                    ...errorMetadata(error),
                  })
                }
              })())
            }
            try {
              const cleanupResult = await cleanupRun(
                sandbox,
                `/workspace/runs/${runId}`,
                runId,
                defer
              )
              const cleanupSuccess =
                !cleanupResult.timedOut &&
                cleanupResult.exitCode === 0 &&
                !cleanupResult.truncated
              logAnalysis("cleanup", {
                runId,
                status: cleanupSuccess ? "success" : "failed",
                durationMs: Date.now() - cleanupStartedAt,
                exitCode: cleanupResult.exitCode,
                timedOut: cleanupResult.timedOut,
                truncated: cleanupResult.truncated,
                primaryStatus:
                  primaryError === undefined ? "success" : "failed",
              })
            } catch (cleanupError) {
              logAnalysis("cleanup", {
                runId,
                status: "failed",
                durationMs: Date.now() - cleanupStartedAt,
                primaryStatus:
                  primaryError === undefined ? "success" : "failed",
                ...errorMetadata(cleanupError),
              })
            }
          }
        }
      },
    }),
  }
}

function terminalModeForPhase(
  phase: AnalysisPhase | string
): "recoverable" | "terminal" {
  return phase === "output" ? "recoverable" : "terminal"
}
