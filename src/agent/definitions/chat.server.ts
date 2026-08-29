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
import { createToolErrorTransform, sanitizeToolErrorMessage, ToolFailureTracker } from "@/agent/tools/errors.server"
import { buildAiRun, getMonthlyLimitUsd, getMonthlySpend, insertAiRun } from "@/agent/usage/api.server"
import type { ChatProgressCallbacks } from "@/agent/runtime/chat-progress.server"

const CHAT_TOTAL_TIMEOUT_MS = 90_000
const CHAT_STEP_TIMEOUT_MS = 45_000
const CHAT_CHUNK_TIMEOUT_MS = 30_000
const CHAT_MAX_STEPS = 20
const CHAT_FINAL_STEP = CHAT_MAX_STEPS - 1
const FINAL_CONCLUSION_INSTRUCTION = `This is the final permitted model step. Tools are unavailable. Give the user a concise conclusion now using the information already gathered. If the request could not be completed, clearly explain the blocker and what the user can do next.`

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
  abortSignal,
  progress,
}: {
  messages: ChatMessage[]
  onEnd: GenerateTextOnEndCallback<ToolSet>
  userId: string
  threadId: string | null
  modelKey?: GeneralChatModelKey
  abortSignal?: AbortSignal
  progress?: ChatProgressCallbacks
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
  const baseInstructions = renderSystemPrompt(skills)
  const tools = {
    ...skillTools,
    ...createPortfolioTools(userId),
    ...stockTools,
    ...researchTools,
    ...createAnalysisTools(userId, ({ toolCallId, phase }) => progress?.analysisPhase(toolCallId, phase)),
  }
  const toolNames = Object.keys(tools) as Array<keyof typeof tools & string>
  const failureTracker = new ToolFailureTracker()

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
        error: sanitizeToolErrorMessage(err),
      }))
    }
    await onEnd(event)
  }

  return streamText({
    model: createModel(modelId),
    instructions: baseInstructions,
    tools,
    experimental_transform: createToolErrorTransform({ tracker: failureTracker, abortSignal }),
    prepareStep: ({ stepNumber }) => {
      const unavailable = failureTracker.unavailableReasons()
      const unavailableInstruction = unavailable.length > 0
        ? `The following tools are unavailable for the rest of this turn. Do not call them; use another tool or explain the limitation:\n${unavailable.map((reason) => `- ${reason}`).join("\n")}`
        : null
      const finalStep = stepNumber === CHAT_FINAL_STEP
      return {
        activeTools: finalStep ? [] : toolNames.filter((toolName) => !failureTracker.isDisabled(toolName)),
        ...(finalStep ? { toolChoice: "none" as const } : {}),
        instructions: [baseInstructions, unavailableInstruction, finalStep ? FINAL_CONCLUSION_INSTRUCTION : null]
          .filter((part): part is string => part !== null)
          .join("\n\n"),
      }
    },
    messages: modelMessages,
    abortSignal,
    // Provider transport retries remain at the AI SDK default. There are no
    // application/tool retries or tool-call repair hooks in this loop.
    stopWhen: isStepCount(CHAT_MAX_STEPS),
    timeout: {
      totalMs: CHAT_TOTAL_TIMEOUT_MS,
      stepMs: CHAT_STEP_TIMEOUT_MS,
      chunkMs: CHAT_CHUNK_TIMEOUT_MS,
    },
    onError: (event) => {
      progress?.recovering()
      console.error(JSON.stringify({
        event: "agent.chat.error",
        threadId,
        error: sanitizeToolErrorMessage(event.error),
      }))
    },
    onAbort: (event) => {
      progress?.cancelled()
      console.warn(JSON.stringify({
        event: "agent.chat.abort",
        threadId,
        steps: event.steps.length,
      }))
    },
    onToolExecutionStart: (event) => {
      progress?.toolStarted(event.toolCall.toolName, event.toolCall.toolCallId, event.toolCall.input)
      console.info(JSON.stringify({
        event: "agent.chat.tool_start",
        threadId,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
      }))
    },
    onToolExecutionEnd: (event) => {
      const output = event.toolOutput.type === "tool-result" ? event.toolOutput.output : undefined
      const businessFailure = typeof output === "object" && output !== null && "success" in output && output.success === false
      const success = event.toolOutput.type === "tool-result" && !businessFailure
      const error = event.toolOutput.type === "tool-error" ? event.toolOutput.error : undefined
      const outputJson = output === undefined ? undefined : JSON.stringify(output)
      progress?.toolFinished(event.toolCall.toolName, event.toolCall.toolCallId, success, output)
      console.info(JSON.stringify({
        event: "agent.chat.tool_finish",
        threadId,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        success,
        durationMs: event.toolExecutionMs,
        outputBytes: outputJson === undefined ? undefined : new TextEncoder().encode(outputJson).byteLength,
        error: error === undefined ? undefined : sanitizeToolErrorMessage(error),
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
    onStepStart: (event) => {
      if (event.stepNumber === 0) progress?.waiting(event.stepNumber)
      else progress?.composing(event.stepNumber)
    },
    onChunk: ({ chunk }) => {
      if (chunk.type === "text-start") progress?.composing(0)
    },
    onEnd: wrappedOnEnd,
  })
}
