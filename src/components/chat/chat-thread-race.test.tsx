// @vitest-environment jsdom

import { StrictMode, useEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@/agent/chat-message"
import type { Thread } from "@/thread/types"
import { ChatPanel } from "@/components/chat/chat-panel"
import {
  readPendingInitialMessage,
  writePendingInitialMessage,
} from "@/components/chat/chat-initial-message"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function thread(id: string, title: string): Thread {
  return {
    id,
    userId: "user-1",
    title,
    modelKey: "flash",
    providerOptions: {},
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  }
}

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  getThread: vi.fn(),
  listThreads: vi.fn(),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  sendByThread: new Map<string, ReturnType<typeof vi.fn>>(),
  messagesByThread: new Map<string, ChatMessage[]>(),
  statusByThread: new Map<string, "ready" | "submitted" | "streaming" | "error">(),
  mounted: [] as string[],
  unmounted: [] as string[],
}))

vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({ userId: "user-1" }),
}))

vi.mock("@/thread/functions", () => ({
  createThreadFn: mocks.createThread,
  getThreadFn: mocks.getThread,
  listThreadsFn: mocks.listThreads,
  updateThreadFn: mocks.updateThread,
  deleteThreadFn: mocks.deleteThread,
}))

vi.mock("agents/react", () => ({
  useAgent: ({ name }: { name: string }) => ({
    name,
    connectionError: null,
    reconnect: vi.fn(),
  }),
}))

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: ({ agent }: { agent: { name: string } }) => {
    const threadId = agent.name
    useEffect(() => {
      mocks.mounted.push(threadId)
      return () => {
        mocks.unmounted.push(threadId)
      }
    }, [threadId])

    let sendMessage = mocks.sendByThread.get(threadId)
    if (!sendMessage) {
      sendMessage = vi.fn()
      mocks.sendByThread.set(threadId, sendMessage)
    }
    const messages = mocks.messagesByThread.get(threadId) ?? []
    const status = mocks.statusByThread.get(threadId) ?? "ready"

    return {
      messages,
      sendMessage,
      regenerate: vi.fn(),
      stop: vi.fn(),
      clearError: vi.fn(),
      status,
      error: null,
      isStreaming: status === "streaming",
      isRecovering: false,
      isToolContinuation: false,
      connectionError: null,
    }
  },
}))

class ObserverStub {
  observe() {}
  disconnect() {}
}

class StorageStub {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendByThread.clear()
  mocks.messagesByThread.clear()
  mocks.statusByThread.clear()
  mocks.mounted.length = 0
  mocks.unmounted.length = 0
  vi.stubGlobal("ResizeObserver", ObserverStub)
  vi.stubGlobal("IntersectionObserver", ObserverStub)
  vi.stubGlobal("localStorage", new StorageStub())
  localStorage.clear()
  mocks.messagesByThread.set("old-thread", [{
    id: "old-user-message",
    role: "user",
    parts: [{ type: "text", text: "old secret context" }],
  } as ChatMessage])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("chat thread lifecycle integration", () => {
  it("unmounts the old transcript and sends only the fresh prompt after New", async () => {
    const oldThread = thread("old-thread", "Old conversation")
    const newThread = thread("new-thread", "New conversation")
    const creation = deferred<Thread>()
    mocks.getThread.mockResolvedValue(oldThread)
    mocks.listThreads.mockResolvedValue({ threads: [oldThread], nextCursor: null })
    mocks.createThread.mockReturnValue(creation.promise)
    mocks.updateThread.mockResolvedValue(undefined)
    localStorage.setItem("activeThreadId", oldThread.id)

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    expect(await screen.findByText("old secret context")).toBeTruthy()
    expect(mocks.mounted).toContain("old-thread")

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }))
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }))

    await waitFor(() => {
      expect(screen.queryByText("old secret context")).toBeNull()
      expect(mocks.unmounted).toContain("old-thread")
    })

    const input = screen.getByPlaceholderText("Ask about your portfolio…")
    fireEvent.change(input, { target: { value: "fresh prompt only" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await act(async () => {
      creation.resolve(newThread)
      await creation.promise
    })

    await waitFor(() => {
      expect(mocks.mounted).toContain("new-thread")
      expect(mocks.sendByThread.get("new-thread")).toHaveBeenCalledTimes(1)
    })
    expect(mocks.sendByThread.get("new-thread")).toHaveBeenCalledWith({
      id: expect.any(String),
      role: "user",
      parts: [{ type: "text", text: "fresh prompt only" }],
      metadata: { turnGeneration: 1 },
    })
    expect(mocks.sendByThread.get("old-thread")).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.sendByThread.get("new-thread")?.mock.calls)).not.toContain("old secret context")
  })

  it("restores and retries the same first message after reload before socket acceptance", async () => {
    const newThread = thread("reload-thread", "New conversation")
    const creation = deferred<Thread>()
    mocks.createThread.mockReturnValue(creation.promise)
    mocks.getThread.mockResolvedValue(newThread)
    mocks.listThreads.mockResolvedValue({ threads: [], nextCursor: null })

    const firstClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const firstRender = render(
      <QueryClientProvider client={firstClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    const input = await screen.findByPlaceholderText("Ask about your portfolio…")
    fireEvent.change(input, { target: { value: "survive reload" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {
      creation.resolve(newThread)
      await creation.promise
    })

    await waitFor(() => expect(mocks.sendByThread.get(newThread.id)).toHaveBeenCalledTimes(1))
    const firstPayload = mocks.sendByThread.get(newThread.id)?.mock.calls[0]?.[0]
    expect(firstPayload).toMatchObject({
      id: expect.any(String),
      role: "user",
      parts: [{ type: "text", text: "survive reload" }],
    })
    expect(readPendingInitialMessage(localStorage, newThread.id)).toEqual({
      id: firstPayload.id,
      text: "survive reload",
    })

    firstRender.unmount()
    const secondClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={secondClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(mocks.sendByThread.get(newThread.id)).toHaveBeenCalledTimes(2))
    expect(mocks.sendByThread.get(newThread.id)?.mock.calls[1]?.[0]).toMatchObject({
      id: firstPayload.id,
      role: "user",
      parts: [{ type: "text", text: "survive reload" }],
    })
  })

  it("preserves a superseded create's prompt until that thread is selected", async () => {
    const createdThread = thread("deferred-thread-a", "Deferred A")
    const creation = deferred<Thread>()
    mocks.createThread.mockReturnValue(creation.promise)
    mocks.listThreads.mockResolvedValue({ threads: [createdThread], nextCursor: null })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    const firstInput = await screen.findByPlaceholderText("Ask about your portfolio…")
    fireEvent.change(firstInput, { target: { value: "prompt from A" } })
    fireEvent.keyDown(firstInput, { key: "Enter" })

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }))
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }))

    await act(async () => {
      creation.resolve(createdThread)
      await creation.promise
    })

    const currentDraftInput = screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement
    expect(currentDraftInput.disabled).toBe(false)
    expect(localStorage.getItem("activeThreadId")).toBeNull()
    const pending = readPendingInitialMessage(localStorage, createdThread.id)
    expect(pending).toMatchObject({ id: expect.any(String), text: "prompt from A" })
    expect(mocks.mounted).not.toContain(createdThread.id)

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }))
    fireEvent.click(screen.getByText("Deferred A").closest("button")!)

    await waitFor(() => expect(mocks.sendByThread.get(createdThread.id)).toHaveBeenCalledTimes(1))
    expect(mocks.sendByThread.get(createdThread.id)).toHaveBeenCalledWith({
      id: pending?.id,
      role: "user",
      parts: [{ type: "text", text: "prompt from A" }],
      metadata: { turnGeneration: 1 },
    })
  })

  it("dedupes an already-persisted first message during hydration", async () => {
    const restoredThread = thread("persisted-thread", "Persisted")
    const pending = { id: "stable-user-message", text: "already accepted" }
    localStorage.setItem("activeThreadId", restoredThread.id)
    writePendingInitialMessage(localStorage, restoredThread.id, pending)
    mocks.getThread.mockResolvedValue(restoredThread)
    mocks.listThreads.mockResolvedValue({ threads: [restoredThread], nextCursor: null })
    mocks.messagesByThread.set(restoredThread.id, [{
      id: pending.id,
      role: "user",
      parts: [{ type: "text", text: pending.text }],
    } as ChatMessage])

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    expect(await screen.findByText(pending.text)).toBeTruthy()
    await waitFor(() => expect(readPendingInitialMessage(localStorage, restoredThread.id)).toBeNull())
    expect(mocks.sendByThread.get(restoredThread.id)).not.toHaveBeenCalled()
  })

  it("applies only the live restore under StrictMode", async () => {
    const restoredThread = thread("strict-thread", "Strict restore")
    const pending = { id: "strict-stable-message", text: "restore exactly once" }
    const staleRestore = deferred<Thread | null>()
    const liveRestore = deferred<Thread | null>()
    localStorage.setItem("activeThreadId", restoredThread.id)
    writePendingInitialMessage(localStorage, restoredThread.id, pending)
    mocks.getThread
      .mockReturnValueOnce(staleRestore.promise)
      .mockReturnValueOnce(liveRestore.promise)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ChatPanel />
        </QueryClientProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(mocks.getThread).toHaveBeenCalledTimes(2))

    await act(async () => {
      staleRestore.resolve(restoredThread)
      await staleRestore.promise
    })
    expect(mocks.sendByThread.get(restoredThread.id)).toBeUndefined()

    await act(async () => {
      liveRestore.resolve(restoredThread)
      await liveRestore.promise
    })
    await waitFor(() => expect(mocks.sendByThread.get(restoredThread.id)).toHaveBeenCalledTimes(1))
    expect(mocks.sendByThread.get(restoredThread.id)).toHaveBeenCalledWith({
      id: pending.id,
      role: "user",
      parts: [{ type: "text", text: pending.text }],
      metadata: { turnGeneration: 1 },
    })
  })

  it("clears the handoff after the Agent accepts the exact first message", async () => {
    const newThread = thread("accepted-thread", "New conversation")
    mocks.createThread.mockResolvedValue(newThread)
    mocks.listThreads.mockResolvedValue({ threads: [], nextCursor: null })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )
    const input = await screen.findByPlaceholderText("Ask about your portfolio…")
    fireEvent.change(input, { target: { value: "accepted prompt" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(mocks.sendByThread.get(newThread.id)).toHaveBeenCalledTimes(1))
    const payload = mocks.sendByThread.get(newThread.id)?.mock.calls[0]?.[0]
    expect(readPendingInitialMessage(localStorage, newThread.id)?.id).toBe(payload.id)

    mocks.messagesByThread.set(newThread.id, [{
      id: payload.id,
      role: "user",
      parts: payload.parts,
    } as ChatMessage])
    mocks.statusByThread.set(newThread.id, "streaming")
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ChatPanel />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(readPendingInitialMessage(localStorage, newThread.id)).toBeNull())
  })
})
