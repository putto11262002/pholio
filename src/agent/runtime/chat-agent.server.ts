import { AIChatAgent } from "@cloudflare/ai-chat"
import { createUIMessageStreamResponse, toUIMessageStream } from "ai"
import type { GenerateTextOnEndCallback, ToolSet } from "ai"
import type { OnChatMessageOptions } from "@cloudflare/ai-chat"
import { verifyToken } from "@clerk/backend"
import type { ChatMessage } from "@/agent/chat-message"
import { runChatAgent } from "@/agent/definitions/chat.server"
import type { GeneralChatModelKey } from "@/agent/general-chat-models"
import { MISSING_STREAM_ERROR } from "@/agent/tools/errors.server"
import { getThreadOwnerUserId } from "@/thread/api.server"

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

    const result = await runChatAgent({
      messages: this.messages as ChatMessage[],
      onEnd,
      userId,
      threadId,
      modelKey,
      abortSignal: options?.abortSignal,
    })

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        sendReasoning: true,
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
