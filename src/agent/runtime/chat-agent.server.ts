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

export class ChatAgent extends AIChatAgent<Env> {
  private async getThreadUserId(): Promise<string> {
    const userId = await getThreadOwnerUserId(this.name)
    if (!userId) throw new Error("Thread not found")
    return userId
  }

  async onChatMessage(onEnd: GenerateTextOnEndCallback<ToolSet>, options?: OnChatMessageOptions) {
    const modelKey = options?.body?.modelKey as GeneralChatModelKey | undefined
    const userId = await this.getThreadUserId()
    const threadId = this.name

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
            const result = await runChatAgent({
              messages: this.messages as ChatMessage[],
              onEnd,
              userId,
              threadId,
              modelKey,
              abortSignal: options?.abortSignal,
              progress: progress.callbacks,
            })

            const responseStream = toUIMessageStream<ToolSet, ChatMessage>({
              stream: result.stream,
              sendReasoning: false,
              onError: () => {
                if (options?.abortSignal?.aborted) progress.cancelled()
                else progress.failed(MISSING_STREAM_ERROR)
                return MISSING_STREAM_ERROR
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
              if (options?.abortSignal?.aborted) progress.cancelled()
              else progress.failed(MISSING_STREAM_ERROR)
              throw error
            } finally {
              reader.releaseLock()
            }
          } catch (error) {
            if (options?.abortSignal?.aborted) progress.cancelled()
            else progress.failed(MISSING_STREAM_ERROR)
            throw error
          }
        },
        onError: () => MISSING_STREAM_ERROR,
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
