import { and, count, desc, gte, eq, sql, sum } from "drizzle-orm"
import type { GenerateTextEndEvent, ToolSet } from "ai"
import { getDb } from "@/db/index.server"
import { aiRun } from "@/db/schema"
import { computeCostUsd } from "./pricing"
import type { AiRunType } from "./schemas"
import type { AiRun, NewAiRun } from "./types"

// Default monthly cost limit — override with MONTHLY_COST_LIMIT_USD env var
const DEFAULT_MONTHLY_LIMIT_USD = 10

export function getMonthlyLimitUsd(): number {
  return Number(process.env.MONTHLY_COST_LIMIT_USD ?? DEFAULT_MONTHLY_LIMIT_USD)
}

function startOfCurrentMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export async function getMonthlySpend(userId: string): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ total: sum(aiRun.costUsd) })
    .from(aiRun)
    .where(and(eq(aiRun.userId, userId), gte(aiRun.createdAt, startOfCurrentMonth())))
  return Number(row?.total ?? "0")
}

export type UsageSummary = {
  totalCostUsd: number
  totalRuns: number
  totalInputTokens: number
  totalOutputTokens: number
  byModel: Array<{ model: string; costUsd: number; runs: number }>
  monthlyLimitUsd: number
}

export async function getMonthlyUsageSummary(userId: string): Promise<UsageSummary> {
  const db = getDb()
  const rows = await db
    .select({
      model: aiRun.model,
      totalCost: sum(aiRun.costUsd),
      totalInputTokens: sum(aiRun.inputTokens),
      totalOutputTokens: sum(aiRun.outputTokens),
      runCount: count(),
    })
    .from(aiRun)
    .where(and(eq(aiRun.userId, userId), gte(aiRun.createdAt, startOfCurrentMonth())))
    .groupBy(aiRun.model)

  const byModel = rows.map((r) => ({
    model: r.model,
    costUsd: Number(r.totalCost ?? "0"),
    runs: r.runCount,
  }))

  return {
    totalCostUsd: byModel.reduce((acc, r) => acc + r.costUsd, 0),
    totalRuns: rows.reduce((acc, r) => acc + r.runCount, 0),
    totalInputTokens: rows.reduce((acc, r) => acc + Number(r.totalInputTokens ?? 0), 0),
    totalOutputTokens: rows.reduce((acc, r) => acc + Number(r.totalOutputTokens ?? 0), 0),
    byModel,
    monthlyLimitUsd: getMonthlyLimitUsd(),
  }
}

export type DailyUsageRow = {
  day: string
  model: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  runs: number
}

export async function getDailyUsage(userId: string, days = 7): Promise<DailyUsageRow[]> {
  const db = getDb()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${aiRun.createdAt})::date::text`.as("day"),
      model: aiRun.model,
      totalCost: sum(aiRun.costUsd),
      totalInputTokens: sum(aiRun.inputTokens),
      totalOutputTokens: sum(aiRun.outputTokens),
      runCount: count(),
    })
    .from(aiRun)
    .where(and(eq(aiRun.userId, userId), gte(aiRun.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${aiRun.createdAt})`, aiRun.model)
    .orderBy(sql`date_trunc('day', ${aiRun.createdAt})`)

  return rows.map((r) => ({
    day: r.day,
    model: r.model,
    costUsd: Number(r.totalCost ?? "0"),
    inputTokens: Number(r.totalInputTokens ?? 0),
    outputTokens: Number(r.totalOutputTokens ?? 0),
    runs: r.runCount,
  }))
}

export type AiRunRow = Omit<AiRun, "meta">

export async function getRecentRuns(userId: string, limit = 20): Promise<AiRunRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: aiRun.id,
      userId: aiRun.userId,
      threadId: aiRun.threadId,
      type: aiRun.type,
      model: aiRun.model,
      stepCount: aiRun.stepCount,
      inputTokens: aiRun.inputTokens,
      cacheReadTokens: aiRun.cacheReadTokens,
      cacheWriteTokens: aiRun.cacheWriteTokens,
      outputTokens: aiRun.outputTokens,
      reasoningTokens: aiRun.reasoningTokens,
      costUsd: aiRun.costUsd,
      durationMs: aiRun.durationMs,
      finishReason: aiRun.finishReason,
      toolsUsed: aiRun.toolsUsed,
      createdAt: aiRun.createdAt,
    })
    .from(aiRun)
    .where(eq(aiRun.userId, userId))
    .orderBy(desc(aiRun.createdAt))
    .limit(limit)
  return rows
}

export async function insertAiRun(data: NewAiRun): Promise<void> {
  const db = getDb()
  await db.insert(aiRun).values(data)
}

export function buildAiRun({
  event,
  userId,
  threadId,
  type,
  startedAt,
}: {
  event: GenerateTextEndEvent<ToolSet>
  userId: string
  threadId: string | null
  type: AiRunType
  startedAt: number
}): NewAiRun {
  const usage = event.usage
  const inputDetails = usage.inputTokenDetails ?? {}
  const outputDetails = usage.outputTokenDetails ?? {}

  const noCacheTokens = inputDetails.noCacheTokens ?? (usage.inputTokens ?? 0)
  const cacheReadTokens = inputDetails.cacheReadTokens ?? 0
  const cacheWriteTokens = inputDetails.cacheWriteTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const reasoningTokens = outputDetails.reasoningTokens ?? 0

  const modelId = event.model?.modelId ?? "unknown"

  const toolsUsed = Array.from(
    new Set(
      event.steps.flatMap((step) =>
        step.toolCalls.map((tc) => tc.toolName),
      ),
    ),
  )

  return {
    id: crypto.randomUUID(),
    userId,
    threadId,
    type,
    model: modelId,
    stepCount: event.steps.length,
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    costUsd: String(
      computeCostUsd(modelId, { noCacheTokens, cacheReadTokens, cacheWriteTokens, outputTokens }),
    ),
    durationMs: Date.now() - startedAt,
    finishReason: event.finishReason ?? "unknown",
    toolsUsed,
    meta: {},
  }
}
