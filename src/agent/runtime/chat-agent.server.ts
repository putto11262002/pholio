import { AIChatAgent } from "@cloudflare/ai-chat"
import { createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream } from "ai"
import type { GenerateTextOnEndCallback, ToolSet } from "ai"
import type { OnChatMessageOptions } from "@cloudflare/ai-chat"
import { verifyToken } from "@clerk/backend"
import type { ChatMessage } from "@/agent/chat-message"
import { runChatAgent } from "@/agent/definitions/chat.server"
import type { GeneralChatModelKey } from "@/agent/general-chat-models"
import { MISSING_STREAM_ERROR } from "@/agent/tools/errors.server"
import { getThreadOwnerUserId } from "@/thread/api.server"
import {
  createChatProgressEmitter,
  createChatProgressRunId,
} from "@/agent/runtime/chat-progress.server"
import { createChatTurnDiagnostics } from "@/agent/runtime/chat-failure.server"

export class ChatAgent extends AIChatAgent<Env> {
  private async getThreadUserId(): Promise<string> {
    const userId = await getThreadOwnerUserId(this.name)
    if (!userId) throw new Error("Thread not found")
    return userId
  }

  async onChatMessage(onEnd: GenerateTextOnEndCallback<ToolSet>, options?: OnChatMessageOptions) {
    const diagnostics = createChatTurnDiagnostics()
    const modelKey = options?.body?.modelKey as GeneralChatModelKey | undefined
    const threadId = this.name
    const safeStreamError = diagnostics.userError(MISSING_STREAM_ERROR)

    return createUIMessageStreamResponse({
      stream: createUIMessageStream<ChatMessage>({
        originalMessages: this.messages as ChatMessage[],
        execute: async ({ writer }) => {
          const progress = createChatProgressEmitter({
            runId: createChatProgressRunId(options?.requestId),
            write: (chunk) => writer.write(chunk),
          })
          progress.preparing()
          try {
            diagnostics.markPhase("thread_lookup")
            const userId = await this.getThreadUserId()
            const result = await runChatAgent({
              messages: this.messages as ChatMessage[],
              onEnd,
              userId,
              threadId,
              modelKey,
              abortSignal: options?.abortSignal,
              progress: progress.callbacks,
              defer: (task) => this.ctx.waitUntil(task),
              diagnostics,
            })

            const responseStream = toUIMessageStream<ToolSet, ChatMessage>({
              stream: result.stream,
              sendReasoning: false,
              onError: (error) => {
                if (options?.abortSignal?.aborted) {
                  progress.cancelled()
                  return MISSING_STREAM_ERROR
                }
                diagnostics.recordFailure(error, "ui_stream")
                progress.failed(MISSING_STREAM_ERROR)
                return safeStreamError
              },
            })
            const reader = responseStream.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                writer.write(value)
              }
              progress.completed()
            } catch (error) {
              if (!options?.abortSignal?.aborted) diagnostics.recordFailure(error, "ui_stream")
              throw error
            } finally {
              reader.releaseLock()
            }
          } catch (error) {
            if (options?.abortSignal?.aborted) progress.cancelled()
            else {
              diagnostics.recordFailure(error)
              progress.failed(MISSING_STREAM_ERROR)
            }
            throw error
          }
        },
        onError: (error) => {
          if (options?.abortSignal?.aborted) return MISSING_STREAM_ERROR
          diagnostics.recordFailure(error, "ui_stream")
          return safeStreamError
        },
      }),
    })
  }

  async onRequest(request: Request): Promise<Response> {
    const sessionToken = request.headers.get("cookie")?.match(/(?:^|;\s*)__session=([^;]+)/)?.[1]
    if (!sessionToken) return new Response("Unauthorized", { status: 401 })
    let payload: Awaited<ReturnType<typeof verifyToken>>
    try {
      payload = await verifyToken(sessionToken, { secretKey: process.env.CLERK_SECRET_KEY })
    } catch {
      return new Response("Unauthorized", { status: 401 })
    }

    const threadUserId = await getThreadOwnerUserId(this.name)
    if (!threadUserId) return new Response("Not Found", { status: 404 })
    if (threadUserId !== payload.sub) return new Response("Forbidden", { status: 403 })

    if (request.method === "DELETE") {
      this.messages = []
      return new Response(null, { status: 204 })
    }
    return super.onRequest(request)
  }
}
