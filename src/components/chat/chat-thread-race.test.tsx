// @vitest-environment jsdom

import { useEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@/agent/chat-message"
import type { Thread } from "@/thread/types"
import { ChatPanel } from "@/components/chat/chat-panel"

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
    const messages: ChatMessage[] = threadId === "old-thread"
      ? [{
          id: "old-user-message",
          role: "user",
          parts: [{ type: "text", text: "old secret context" }],
        } as ChatMessage]
      : []

    return {
      messages,
      sendMessage,
      regenerate: vi.fn(),
      stop: vi.fn(),
      clearError: vi.fn(),
      status: "ready",
      error: null,
      isStreaming: false,
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
  mocks.mounted.length = 0
  mocks.unmounted.length = 0
  vi.stubGlobal("ResizeObserver", ObserverStub)
  vi.stubGlobal("IntersectionObserver", ObserverStub)
  vi.stubGlobal("localStorage", new StorageStub())
  localStorage.clear()
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
      text: "fresh prompt only",
      metadata: { turnGeneration: 1 },
    })
    expect(mocks.sendByThread.get("old-thread")).not.toHaveBeenCalled()
    expect(JSON.stringify(mocks.sendByThread.get("new-thread")?.mock.calls)).not.toContain("old secret context")
  })
})
