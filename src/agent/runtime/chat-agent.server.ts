import { AIChatAgent } from "@cloudflare/ai-chat"
import { MessageType } from "@cloudflare/ai-chat/types"
import { createUIMessageStream, createUIMessageStreamResponse, toUIMessageStream } from "ai"
import { callable } from "agents"
import type { ChatResponseResult, OnChatMessageOptions } from "@cloudflare/ai-chat"
import type { GenerateTextOnEndCallback, InferUIMessageChunk, ToolSet } from "ai"
import type { Connection, WSMessage } from "agents"
import type { ChatMessage } from "@/agent/chat-message"
import {
  CHAT_SETTLEMENT_TIMEOUT_MS,
  type ChatSettlementResult,
} from "@/agent/chat-settlement"
import { runChatAgent } from "@/agent/definitions/chat.server"
import type { GeneralChatModelKey } from "@/agent/general-chat-models"
import { MISSING_STREAM_ERROR } from "@/agent/tools/errors.server"
import { getThreadOwnerUserId } from "@/thread/api.server"
import {
  createChatProgressEmitter,
  createChatProgressRunId,
} from "@/agent/runtime/chat-progress.server"
import { createChatTurnDiagnostics } from "@/agent/runtime/chat-failure.server"
import { authorizeChatAgentRequest } from "@/agent/runtime/chat-agent-auth.server"

const TURN_USER_MESSAGE_ID_BODY_KEY = "pholioTurnUserMessageId"

type ChatRequestFrame = {
  type: MessageType.CF_AGENT_USE_CHAT_REQUEST
  id: string
  init: {
    method?: string
    body?: string
    [key: string]: unknown
  }
}

type ChatRequestBody = {
  messages?: Array<{ id?: unknown; role?: unknown } | null | undefined>
  trigger?: unknown
  [TURN_USER_MESSAGE_ID_BODY_KEY]?: unknown
  [key: string]: unknown
}

function parseChatProtocolMessage(message: WSMessage): unknown {
  if (typeof message !== "string") return undefined
  try {
    return JSON.parse(message)
  } catch {
    return undefined
  }
}

function parseChatRequest(frame: unknown): { frame: ChatRequestFrame; body: ChatRequestBody } | undefined {
  if (!frame || typeof frame !== "object") return
  const candidate = frame as Partial<ChatRequestFrame>
  if (candidate.type !== MessageType.CF_AGENT_USE_CHAT_REQUEST
    || typeof candidate.id !== "string"
    || !candidate.init
    || candidate.init.method !== "POST"
    || typeof candidate.init.body !== "string") return
  try {
    const body = JSON.parse(candidate.init.body) as unknown
    if (!body || typeof body !== "object") return
    return { frame: candidate as ChatRequestFrame, body: body as ChatRequestBody }
  } catch {
    return
  }
}

function submittedUserMessageId(body: ChatRequestBody): string | undefined {
  if (!Array.isArray(body.messages)) return
  const message = body.messages.at(-1)
  if (message?.role === "user" && typeof message.id === "string" && message.id) return message.id
}

function latestUserMessageId(body: ChatRequestBody): string | undefined {
  if (!Array.isArray(body.messages)) return
  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index]
    if (message?.role === "user" && typeof message.id === "string" && message.id) return message.id
  }
}

function withTurnUserMessageId(
  frame: ChatRequestFrame,
  body: ChatRequestBody,
  userMessageId: string,
): string {
  return JSON.stringify({
    ...frame,
    init: {
      ...frame.init,
      body: JSON.stringify({ ...body, [TURN_USER_MESSAGE_ID_BODY_KEY]: userMessageId }),
    },
  })
}

export async function forwardChatUIStream({
  stream,
  abortSignal,
  write,
  completed,
  cancelled,
}: {
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>
  abortSignal?: AbortSignal
  write: (chunk: InferUIMessageChunk<ChatMessage>) => void
  completed: () => void
  cancelled: () => void
}): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (abortSignal?.aborted && value.type === "error") continue
      write(value)
    }
    if (abortSignal?.aborted) cancelled()
    else completed()
  } catch (error) {
    if (abortSignal?.aborted) {
      cancelled()
      return
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}

export class ChatAgent extends AIChatAgent<Env> {
  private readonly activeTurnClaims = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql`create table if not exists pholio_chat_turn_claims (
      user_message_id text primary key,
      request_id text not null,
      status text not null,
      updated_at integer not null default (unixepoch())
    )`
    this.sql`create index if not exists pholio_chat_turn_claims_request_id
      on pholio_chat_turn_claims (request_id)`

    if (!this._resumableStream.hasActiveStream()) {
      this.sql`delete from pholio_chat_turn_claims
        where status = 'accepted'
          and not exists (
            select 1 from cf_ai_chat_agent_messages
            where json_extract(message, '$.id') = pholio_chat_turn_claims.user_message_id
              and json_extract(message, '$.role') = 'user'
          )`
    }

    const sdkOnMessage = this.onMessage.bind(this)
    this.onMessage = (connection, message) => this.handleIdempotentMessage(
      connection,
      message,
      sdkOnMessage,
    )
  }

  private claimSubmit(userMessageId: string, requestId: string): boolean {
    if (this.activeTurnClaims.has(userMessageId)) return false
    const inserted = this.sql<{ user_message_id: string }>`
      insert into pholio_chat_turn_claims (user_message_id, request_id, status, updated_at)
      values (${userMessageId}, ${requestId}, 'accepted', unixepoch())
      on conflict (user_message_id) do nothing
      returning user_message_id
    `
    if (inserted.length === 0) return false
    this.activeTurnClaims.add(userMessageId)
    return true
  }

  private reopenForRegenerate(userMessageId: string, requestId: string): void {
    const updated = this.sql<{ user_message_id: string }>`
      update pholio_chat_turn_claims
      set request_id = ${requestId}, status = 'accepted', updated_at = unixepoch()
      where user_message_id = ${userMessageId}
      returning user_message_id
    `
    if (updated.length > 0) this.activeTurnClaims.add(userMessageId)
  }

  private syncAndCompleteDuplicate(connection: Connection, requestId: string): void {
    try {
      connection.send(JSON.stringify({
        type: MessageType.CF_AGENT_CHAT_MESSAGES,
        messages: this.messages,
      }))
      connection.send(JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true,
      }))
    } catch {
      // A disconnected duplicate needs no further delivery work.
    }
  }

  private releaseUnpersistedClaim(userMessageId: string, requestId: string): void {
    const userWasPersisted = this.messages.some(
      (message) => message.role === "user" && message.id === userMessageId,
    )
    if (userWasPersisted) {
      this.sql`update pholio_chat_turn_claims
        set status = 'error', updated_at = unixepoch()
        where user_message_id = ${userMessageId}
          and request_id = ${requestId}
          and status = 'accepted'`
    } else {
      this.sql`delete from pholio_chat_turn_claims
        where user_message_id = ${userMessageId}
          and request_id = ${requestId}
          and status = 'accepted'`
    }
    this.activeTurnClaims.delete(userMessageId)
  }

  private async handleIdempotentMessage(
    connection: Connection,
    message: WSMessage,
    sdkOnMessage: (connection: Connection, message: WSMessage) => void | Promise<void>,
  ): Promise<void> {
    const protocolMessage = parseChatProtocolMessage(message)
    if ((protocolMessage as { type?: unknown } | undefined)?.type === MessageType.CF_AGENT_CHAT_CLEAR) {
      this.activeTurnClaims.clear()
      this.sql`delete from pholio_chat_turn_claims`
      await sdkOnMessage(connection, message)
      return
    }

    const request = parseChatRequest(protocolMessage)
    if (!request) {
      await sdkOnMessage(connection, message)
      return
    }
    const regenerate = request.body.trigger === "regenerate-message"
    const userMessageId = regenerate
      ? latestUserMessageId(request.body)
      : submittedUserMessageId(request.body)
    if (!userMessageId) {
      await sdkOnMessage(connection, message)
      return
    }

    if (regenerate) this.reopenForRegenerate(userMessageId, request.frame.id)
    else if (!this.claimSubmit(userMessageId, request.frame.id)) {
      this.syncAndCompleteDuplicate(connection, request.frame.id)
      return
    }

    const delegatedMessage = withTurnUserMessageId(request.frame, request.body, userMessageId)
    try {
      await sdkOnMessage(connection, delegatedMessage)
    } catch (error) {
      this.releaseUnpersistedClaim(userMessageId, request.frame.id)
      throw error
    }
  }

  private async getThreadUserId(): Promise<string> {
    const userId = await getThreadOwnerUserId(this.name)
    if (!userId) throw new Error("Thread not found")
    return userId
  }

  // The Worker authenticates callable WebSockets before routing; onRequest repeats the guard.
  @callable({ description: "Wait for the current chat turn to settle" })
  async waitForTurnSettlement(): Promise<ChatSettlementResult> {
    try {
      const stable = await this.waitUntilStable({ timeout: CHAT_SETTLEMENT_TIMEOUT_MS })
      return { status: stable ? "stable" : "timeout" }
    } catch {
      return { status: "unavailable" }
    }
  }

  async onChatMessage(onEnd: GenerateTextOnEndCallback<ToolSet>, options?: OnChatMessageOptions) {
    const turnUserMessageId = options?.body?.[TURN_USER_MESSAGE_ID_BODY_KEY]
    if (typeof turnUserMessageId === "string" && options?.requestId) {
      const rebound = this.sql<{ user_message_id: string }>`
        update pholio_chat_turn_claims
        set request_id = ${options.requestId}, updated_at = unixepoch()
        where user_message_id = ${turnUserMessageId} and status = 'accepted'
        returning user_message_id
      `
      if (rebound.length > 0) this.activeTurnClaims.add(turnUserMessageId)
    }
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
                  return MISSING_STREAM_ERROR
                }
                diagnostics.recordFailure(error, "ui_stream")
                progress.failed(MISSING_STREAM_ERROR)
                return safeStreamError
              },
            })
            await forwardChatUIStream({
              stream: responseStream,
              abortSignal: options?.abortSignal,
              write: (chunk) => writer.write(chunk),
              completed: progress.completed,
              cancelled: progress.cancelled,
            })
          } catch (error) {
            if (options?.abortSignal?.aborted) {
              progress.cancelled()
              return
            }
            diagnostics.recordFailure(error)
            progress.failed(MISSING_STREAM_ERROR)
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

  protected onChatResponse(result: ChatResponseResult): void {
    const claims = this.sql<{ user_message_id: string }>`
      update pholio_chat_turn_claims
      set status = ${result.status}, updated_at = unixepoch()
      where request_id = ${result.requestId} and status = 'accepted'
      returning user_message_id
    `
    for (const claim of claims) this.activeTurnClaims.delete(claim.user_message_id)
    super.onChatResponse(result)
  }

  async onRequest(request: Request): Promise<Response> {
    const authFailure = await authorizeChatAgentRequest(
      request,
      this.name,
      process.env.CLERK_SECRET_KEY,
    )
    if (authFailure) return authFailure

    if (request.method === "DELETE") {
      this.activeTurnClaims.clear()
      this.sql`delete from pholio_chat_turn_claims`
      this.messages = []
      return new Response(null, { status: 204 })
    }
    return super.onRequest(request)
  }
}
