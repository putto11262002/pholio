import { streamText, convertToModelMessages, isStepCount } from "ai"
import type { GenerateTextOnEndCallback, StreamTextOnEndCallback, ToolSet } from "ai"
import type { ChatMessage } from "@/agent/chat-message"
import { createModel } from "@/agent/gateway.server"
import { generalChatModels, resolveGeneralChatModelKey, type GeneralChatModelKey } from "@/agent/general-chat-models"
import { listAgentSkills } from "@/agent/skills/registry.server"
import type { AgentSkillMetadata } from "@/agent/skills/types"
import { createAnalysisTools } from "@/agent/tools/analysis.server"
import { createPortfolioTools } from "@/agent/tools/portfolio.server"
import { createResearchTools } from "@/agent/tools/research.server"
import { skillTools } from "@/agent/tools/skills.server"
import { stockTools } from "@/agent/tools/stock.server"
import { stopOnTerminalToolError } from "@/agent/tools/errors.server"
import { buildAiRun, getMonthlyLimitUsd, getMonthlySpend, insertAiRun } from "@/agent/usage/api.server"

const CHAT_TOTAL_TIMEOUT_MS = 90_000
const CHAT_STEP_TIMEOUT_MS = 45_000
const CHAT_CHUNK_TIMEOUT_MS = 30_000

const SYSTEM_PROMPT = `You are Pholio's stock analysis assistant for a retail investor holding US stocks.

Scope:
- Only help with stock, market, portfolio, and investment-analysis questions.
- If the user asks for unrelated work, politely decline and ask for a stock or portfolio analysis question.
- Do not recommend trades, submit orders, or tell the user to buy, sell, or hold. Frame outputs as informational analysis.

Tools:
- Use portfolio_* tools for questions about the user's holdings, performance, allocation, risk, concentration, gains/losses, or portfolio impact.
- Use market_* tools for quotes, company context, fundamentals, earnings, analyst context, FX, and compact price-history summaries.
- Use news_* tools for compact recent ticker headlines from the market-data provider.
- Use research_* tools when the user asks for latest/current web context, external source-backed facts, company announcements, filings, investor-relations pages, or broader market/news context not covered by market/news tools.
- Prefer research_* tools when an answer depends on up-to-date or time-sensitive information.
- Use the most specific compact tool before asking for broader data.
- Use analysis_run_code as a bounded code execution environment when the answer requires calculations, candle analysis, time-series analysis, technical indicators, portfolio concentration, returns, volatility, drawdown, comparisons, or other numerical work.

Code execution rules:
- Use analysis_run_code only for stock, market, or portfolio analysis tasks.
- If a task needs detailed code execution guidance, load the relevant skill before using analysis_run_code.
- If analysis output includes artifacts, place them in your final answer with [artifact:<id>] markers where they should appear. Use only artifact ids returned by the tool. Do not invent artifact ids.

Skill loading rules:
- When a task would benefit from a skill, call skill_load before doing the work.
- skill_load returns only SKILL.md.
- If the loaded skill lists reference files you need, call skill_read_file for the specific file.
- Do not assume all skill files are already in context.

Research rules:
- Use research_search_web for source discovery.
- Use research_read_page before relying on details from a source page.
- Prefer primary or high-quality sources: company investor-relations pages, SEC filings, exchange/vendor data, reputable financial news, then lower-confidence web sources.
- When using research tools, use the citation numbers returned by the tools as bracket markers like [1] and [2]. If one claim uses multiple sources, write separate markers like [1][2]. Do not invent citation numbers.
- If you need to write a literal bracketed number that is not a citation, write it as inline code, like \`[1]\`.
- Keep research concise: normally search once and read 1-3 relevant pages.
- Do not quote long passages; summarize in your own words.
- Do not use research tools for unrelated browsing, broker login, trade placement, form submission, paywall bypass, or access-control bypass.
- Do not send research/page contents into analysis_run_code unless the user explicitly asks for source-text computation.
- If sources disagree or data freshness is unclear, say so.


Be concise and direct. Do not use emojis. Ground answers in actual numbers when available. Explain the computed result in plain English, including uncertainty or data gaps.`

function renderSystemPrompt(skills: AgentSkillMetadata[]): string {
  return [
    SYSTEM_PROMPT,
    "Skills:",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n")
}

export async function runChatAgent({
  messages,
  onEnd,
  userId,
  threadId,
  modelKey: modelKeyOpt,
}: {
  messages: ChatMessage[]
  onEnd: GenerateTextOnEndCallback<ToolSet>
  userId: string
  threadId: string | null
  modelKey?: GeneralChatModelKey
}) {
  const monthlySpend = await getMonthlySpend(userId)
  const limit = getMonthlyLimitUsd()
  if (monthlySpend >= limit) {
    throw new Error(`Monthly usage limit of $${limit.toFixed(2)} reached. Current spend: $${monthlySpend.toFixed(4)}.`)
  }

  const modelKey = resolveGeneralChatModelKey(modelKeyOpt)
  const modelId = generalChatModels[modelKey].id
  const modelMessages = await convertToModelMessages(messages)
  const skills = await listAgentSkills()
  const researchTools = createResearchTools()
  const startedAt = Date.now()

  const wrappedOnEnd: StreamTextOnEndCallback<ToolSet> = async (event) => {
    console.info(JSON.stringify({
      event: "agent.chat.finish",
      threadId,
      stepCount: event.steps.length,
      finishReason: event.finishReason,
      inputTokens: event.usage.inputTokens ?? 0,
      outputTokens: event.usage.outputTokens ?? 0,
      toolsUsed: Array.from(new Set(event.steps.flatMap((step) => step.toolCalls.map((tc) => tc.toolName)))),
    }))
    try {
      await insertAiRun(buildAiRun({ event, userId, threadId, type: "chat", startedAt }))
    } catch (err) {
      console.error(JSON.stringify({
        event: "agent.chat.usage_insert_failed",
        threadId,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
    await onEnd(event)
  }

  return streamText({
    model: createModel(modelId),
    instructions: renderSystemPrompt(skills),
    tools: {
      ...skillTools,
      ...createPortfolioTools(userId),
      ...stockTools,
      ...researchTools,
      ...createAnalysisTools(userId),
    },
    messages: modelMessages,
    stopWhen: [stopOnTerminalToolError, isStepCount(10)],
    timeout: {
      totalMs: CHAT_TOTAL_TIMEOUT_MS,
      stepMs: CHAT_STEP_TIMEOUT_MS,
      chunkMs: CHAT_CHUNK_TIMEOUT_MS,
    },
    onError: (event) => {
      console.error(JSON.stringify({
        event: "agent.chat.error",
        threadId,
        error: event.error instanceof Error ? event.error.message : String(event.error),
      }))
    },
    onAbort: (event) => {
      console.warn(JSON.stringify({
        event: "agent.chat.abort",
        threadId,
        steps: event.steps.length,
      }))
    },
    onToolExecutionStart: (event) => {
      console.info(JSON.stringify({
        event: "agent.chat.tool_start",
        threadId,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
      }))
    },
    onToolExecutionEnd: (event) => {
      const success = event.toolOutput.type === "tool-result"
      const output = success ? event.toolOutput.output : undefined
      const error = success ? undefined : event.toolOutput.error
      const outputJson = output === undefined ? undefined : JSON.stringify(output)
      console.info(JSON.stringify({
        event: "agent.chat.tool_finish",
        threadId,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        success,
        durationMs: event.toolExecutionMs,
        outputBytes: outputJson === undefined ? undefined : new TextEncoder().encode(outputJson).byteLength,
        error: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
      }))
    },
    onStepEnd: (event) => {
      console.info(JSON.stringify({
        event: "agent.chat.step_finish",
        threadId,
        finishReason: event.finishReason,
        toolCalls: event.toolCalls.map((toolCall) => toolCall.toolName),
        toolResults: event.toolResults.map((toolResult) => toolResult.toolName),
      }))
    },
    onEnd: wrappedOnEnd,
  })
}
