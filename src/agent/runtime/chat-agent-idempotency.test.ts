import { beforeEach, describe, expect, it, vi } from "vitest"
import { MessageType } from "@cloudflare/ai-chat/types"
import { ChatAgent } from "./chat-agent.server"
import type { ChatMessage } from "@/agent/chat-message"

const mocks = vi.hoisted(() => ({
  sdkOnMessage: vi.fn(),
}))

vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class {
    messages: Array<ChatMessage> = []
    sql: SqlStore["sql"]
    _resumableStream = { hasActiveStream: () => false }

    constructor(ctx: {
      activeStream?: boolean
      messages?: Array<ChatMessage>
      sql: SqlStore["sql"]
    }) {
      this.sql = ctx.sql
      this.messages = ctx.messages ?? []
      this._resumableStream = { hasActiveStream: () => Boolean(ctx.activeStream) }
    }

    onMessage(connection: unknown, message: unknown) {
      return mocks.sdkOnMessage(this, connection, message)
    }

    onChatResponse() {}
  },
}))
vi.mock("agents", () => ({ callable: () => <T>(method: T) => method }))
vi.mock("@/agent/definitions/chat.server", () => ({ runChatAgent: vi.fn() }))
vi.mock("@/thread/api.server", () => ({ getThreadOwnerUserId: vi.fn() }))

type Claim = { requestId: string; status: string }

class SqlStore {
  readonly claims = new Map<string, Claim>()
  persistedUserIds = new Set<string>()

  sql = <T>(strings: TemplateStringsArray, ...values: Array<unknown>): Array<T> => {
    const query = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase()
    if (query.startsWith("create table") || query.startsWith("create index")) return []
    if (query.includes("not exists ( select 1 from cf_ai_chat_agent_messages")) {
      for (const [userMessageId, claim] of this.claims) {
        if (claim.status === "accepted" && !this.persistedUserIds.has(userMessageId)) {
          this.claims.delete(userMessageId)
        }
      }
      return []
    }
    if (query.startsWith("insert into pholio_chat_turn_claims")) {
      const [userMessageId, requestId] = values as [string, string]
      if (this.claims.has(userMessageId)) return []
      this.claims.set(userMessageId, { requestId, status: "accepted" })
      return [{ user_message_id: userMessageId } as T]
    }
    if (query.startsWith("update pholio_chat_turn_claims") && query.includes("set request_id")) {
      const [requestId, userMessageId] = values as [string, string]
      const claim = this.claims.get(userMessageId)
      const requiresAccepted = query.includes(
        "where user_message_id = ? and status = 'accepted'",
      )
      if (!claim || (requiresAccepted && claim.status !== "accepted")) return []
      claim.requestId = requestId
      claim.status = "accepted"
      return [{ user_message_id: userMessageId } as T]
    }
    if (query.startsWith("update pholio_chat_turn_claims") && query.includes("set status = ?")) {
      const [status, requestId] = values as [string, string]
      const entry = [...this.claims.entries()].find(([, claim]) => (
        claim.requestId === requestId && claim.status === "accepted"
      ))
      if (!entry) return []
      entry[1].status = status
      return [{ user_message_id: entry[0] } as T]
    }
    if (query.startsWith("update pholio_chat_turn_claims") && query.includes("set status = 'error'")) {
      const [userMessageId, requestId] = values as [string, string]
      const claim = this.claims.get(userMessageId)
      if (claim?.requestId === requestId && claim.status === "accepted") claim.status = "error"
      return []
    }
    if (query.startsWith("delete from pholio_chat_turn_claims") && values.length === 0) {
      this.claims.clear()
      return []
    }
    if (query.startsWith("delete from pholio_chat_turn_claims")) {
      const [userMessageId, requestId] = values as [string, string]
      const claim = this.claims.get(userMessageId)
      if (claim?.requestId === requestId && claim.status === "accepted") {
        this.claims.delete(userMessageId)
      }
      return []
    }
    throw new Error(`Unexpected SQL in test: ${query}`)
  }
}

function createAgent(options: {
  activeStream?: boolean
  messages?: Array<ChatMessage>
  store?: SqlStore
} = {}) {
  const store = options.store ?? new SqlStore()
  store.persistedUserIds = new Set(
    options.messages?.filter((message) => message.role === "user").map((message) => message.id),
  )
  const agent = new ChatAgent({
    activeStream: options.activeStream,
    messages: options.messages,
    sql: store.sql,
  } as never, {} as Env)
  return { agent, store }
}

function createConnection() {
  const sent: Array<Record<string, unknown>> = []
  return {
    connection: {
      id: "connection-1",
      send: (message: string) => sent.push(JSON.parse(message) as Record<string, unknown>),
    },
    sent,
  }
}

function submitFrame(requestId: string, messages: Array<ChatMessage>, trigger = "submit-message") {
  return JSON.stringify({
    type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({ messages, trigger }),
    },
  })
}

const userMessage = {
  id: "stable-user-1",
  role: "user",
  parts: [{ type: "text", text: "Analyze this" }],
} as ChatMessage

const assistantMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text: "Canonical answer" }],
} as ChatMessage

async function finishTurn(agent: ChatAgent, requestId: string, status = "completed") {
  await (agent as unknown as {
    onChatResponse: (result: Record<string, unknown>) => void
  }).onChatResponse({
    message: assistantMessage,
    requestId,
    continuation: false,
    status,
  })
}

describe("ChatAgent submit idempotency", () => {
  beforeEach(() => vi.clearAllMocks())

  it("only releases an activation-orphaned claim with no persisted user or live stream", () => {
    const orphanStore = new SqlStore()
    orphanStore.claims.set(userMessage.id, { requestId: "orphan", status: "accepted" })
    createAgent({ store: orphanStore })
    expect(orphanStore.claims.has(userMessage.id)).toBe(false)

    const persistedStore = new SqlStore()
    persistedStore.claims.set(userMessage.id, { requestId: "persisted", status: "accepted" })
    createAgent({ store: persistedStore, messages: [userMessage] })
    expect(persistedStore.claims.has(userMessage.id)).toBe(true)

    const recoveryStore = new SqlStore()
    recoveryStore.claims.set(userMessage.id, { requestId: "recovery", status: "accepted" })
    createAgent({ store: recoveryStore, activeStream: true })
    expect(recoveryStore.claims.has(userMessage.id)).toBe(true)
  })

  it("delegates only one of two submits with the same stable user id", async () => {
    const { agent } = createAgent()
    const { connection, sent } = createConnection()
    let releaseFirst: (() => void) | undefined
    mocks.sdkOnMessage.mockImplementationOnce(async (base: { messages: Array<ChatMessage> }) => {
      base.messages = [userMessage]
      await new Promise<void>((resolve) => { releaseFirst = resolve })
    })

    const first = agent.onMessage(connection as never, submitFrame("request-1", [userMessage]))
    await Promise.resolve()
    await agent.onMessage(connection as never, submitFrame("request-2", [userMessage]))

    expect(mocks.sdkOnMessage).toHaveBeenCalledOnce()
    const delegatedFrame = JSON.parse(mocks.sdkOnMessage.mock.calls[0]?.[2] as string) as {
      init: { body: string }
    }
    expect(JSON.parse(delegatedFrame.init.body)).toMatchObject({
      pholioTurnUserMessageId: userMessage.id,
    })
    expect(sent).toEqual([
      { type: MessageType.CF_AGENT_CHAT_MESSAGES, messages: [userMessage] },
      {
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: "request-2",
        body: "",
        done: true,
      },
    ])

    releaseFirst?.()
    await first
  })

  it("syncs the completed canonical transcript without deleting its assistant", async () => {
    const { agent, store } = createAgent()
    const { connection, sent } = createConnection()
    mocks.sdkOnMessage.mockImplementationOnce(async (
      base: { messages: Array<ChatMessage> },
      _connection: unknown,
      message: string,
    ) => {
      const requestId = (JSON.parse(message) as { id: string }).id
      base.messages = [userMessage, assistantMessage]
      await finishTurn(agent, requestId)
    })

    await agent.onMessage(connection as never, submitFrame("request-1", [userMessage]))
    expect(store.claims.get(userMessage.id)?.status).toBe("completed")
    await agent.onMessage(connection as never, submitFrame("request-2", [userMessage]))

    expect(mocks.sdkOnMessage).toHaveBeenCalledOnce()
    expect(agent.messages).toEqual([userMessage, assistantMessage])
    expect(sent[0]).toEqual({
      type: MessageType.CF_AGENT_CHAT_MESSAGES,
      messages: [userMessage, assistantMessage],
    })
  })

  it("releases a claim when delegation fails before the user is persisted", async () => {
    const { agent } = createAgent()
    const { connection } = createConnection()
    mocks.sdkOnMessage
      .mockRejectedValueOnce(new Error("admission failed"))
      .mockResolvedValueOnce(undefined)

    await expect(agent.onMessage(
      connection as never,
      submitFrame("request-1", [userMessage]),
    )).rejects.toThrow("admission failed")
    await agent.onMessage(connection as never, submitFrame("request-2", [userMessage]))

    expect(mocks.sdkOnMessage).toHaveBeenCalledTimes(2)
  })

  it("delegates tool continuations and submit-shaped frames whose last message is not user", async () => {
    const { agent } = createAgent()
    const { connection } = createConnection()
    mocks.sdkOnMessage.mockResolvedValue(undefined)
    const toolContinuation = JSON.stringify({
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: "tool-1",
      toolName: "question",
      output: "yes",
      autoContinue: true,
    })

    await agent.onMessage(connection as never, toolContinuation)
    await agent.onMessage(
      connection as never,
      submitFrame("continuation-request", [userMessage, assistantMessage]),
    )

    expect(mocks.sdkOnMessage).toHaveBeenCalledTimes(2)
  })

  it("rebinds an accepted receipt to a recovery continuation request", async () => {
    const { agent, store } = createAgent()
    const { connection } = createConnection()
    mocks.sdkOnMessage.mockResolvedValue(undefined)

    await agent.onMessage(connection as never, submitFrame("original-request", [userMessage]))
    await agent.onChatMessage(vi.fn(), {
      body: { pholioTurnUserMessageId: userMessage.id },
      continuation: true,
      requestId: "recovery-request",
    })
    await finishTurn(agent, "recovery-request")

    expect(store.claims.get(userMessage.id)).toEqual({
      requestId: "recovery-request",
      status: "completed",
    })
    expect((agent as unknown as { activeTurnClaims: Set<string> }).activeTurnClaims.has(
      userMessage.id,
    )).toBe(false)
  })

  it("safely finds a regenerate target through null and sparse history entries", async () => {
    const { agent, store } = createAgent()
    const { connection } = createConnection()
    store.claims.set(userMessage.id, { requestId: "failed-request", status: "error" })
    mocks.sdkOnMessage.mockResolvedValue(undefined)
    const malformedMessages = [userMessage, null, , assistantMessage] as unknown as Array<ChatMessage>

    await agent.onMessage(
      connection as never,
      submitFrame("regenerate-request", malformedMessages, "regenerate-message"),
    )

    expect(mocks.sdkOnMessage).toHaveBeenCalledOnce()
    expect(store.claims.get(userMessage.id)).toEqual({
      requestId: "regenerate-request",
      status: "accepted",
    })
  })

  it("keeps error receipts terminal for submit reloads but permits explicit regenerate", async () => {
    const { agent } = createAgent()
    const { connection } = createConnection()
    mocks.sdkOnMessage.mockImplementation(async (
      base: { messages: Array<ChatMessage> },
      _connection: unknown,
      message: string,
    ) => {
      const requestId = (JSON.parse(message) as { id: string }).id
      base.messages = [userMessage]
      await finishTurn(agent, requestId, "error")
    })

    await agent.onMessage(connection as never, submitFrame("request-1", [userMessage]))
    await agent.onMessage(connection as never, submitFrame("request-2", [userMessage]))
    await agent.onMessage(
      connection as never,
      submitFrame("request-3", [userMessage, assistantMessage], "regenerate-message"),
    )

    expect(mocks.sdkOnMessage).toHaveBeenCalledTimes(2)
  })

  it("clears durable receipts before delegating chat clear", async () => {
    const { agent, store } = createAgent()
    const { connection } = createConnection()
    store.claims.set(userMessage.id, { requestId: "request-1", status: "completed" })
    mocks.sdkOnMessage.mockResolvedValue(undefined)
    const clearFrame = JSON.stringify({ type: MessageType.CF_AGENT_CHAT_CLEAR })

    await agent.onMessage(connection as never, clearFrame)

    expect(store.claims.size).toBe(0)
    expect(mocks.sdkOnMessage).toHaveBeenCalledWith(agent, connection, clearFrame)
  })
})
