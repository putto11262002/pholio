// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@/agent/chat-message"

const hook = vi.hoisted(() => ({
  options: null as null | {
    cancelOnClientAbort?: boolean
    onFinish: (event: {
      message: ChatMessage
      messages: ChatMessage[]
      isAbort: boolean
    }) => void
  },
  state: {} as Record<string, unknown>,
}))

const agent = vi.hoisted(() => ({
  connectionError: null,
  reconnect: vi.fn(),
}))

vi.mock("agents/react", () => ({
  useAgent: () => agent,
}))

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: (options: typeof hook.options) => {
    hook.options = options
    return hook.state
  },
}))

import { ConnectedChat } from "./chat-panel"

const userMessage = {
  id: "user-1",
  role: "user",
  metadata: { turnGeneration: 1 },
  parts: [{ type: "text", text: "Run the analysis" }],
} as ChatMessage

function renderConnectedChat() {
  return render(
    <ConnectedChat
      threadId="thread-1"
      modelKey="flash"
      providerOptions={{}}
      activeTitle="Analysis"
      onModelSelect={() => undefined}
      onThinkingSelect={() => undefined}
      onAutoTitle={() => undefined}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hook.options = null
  hook.state = {
    messages: [userMessage],
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    stop: vi.fn(async () => undefined),
    clearError: vi.fn(),
    status: "submitted",
    error: null,
    isStreaming: false,
    isRecovering: false,
    isToolContinuation: false,
    connectionError: null,
  }
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ConnectedChat cancellation", () => {
  it("stays stopping after stop resolves until the hook acknowledges an abort", async () => {
    renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))

    const stop = hook.state.stop as ReturnType<typeof vi.fn>
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByText("Stopping…")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Stopping response" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(true)

    await act(async () => {
      await stop.mock.results[0]?.value
    })

    expect(screen.getByText("Stopping…")).toBeTruthy()
    expect(screen.queryByText("Cancelled — partial response kept.")).toBeNull()

    const emptyAssistant = {
      id: "assistant-empty",
      role: "assistant",
      parts: [],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: emptyAssistant,
      messages: [emptyAssistant],
      isAbort: true,
    }))

    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(false)
  })

  it("stops an active tool continuation through the same explicit hook path", async () => {
    hook.state = {
      ...hook.state,
      status: "ready",
      isStreaming: true,
      isToolContinuation: true,
    }
    renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    expect(screen.getByText("Stopping…")).toBeTruthy()

    const stop = hook.state.stop as ReturnType<typeof vi.fn>
    await act(async () => {
      await stop.mock.results[0]?.value
    })
    expect(screen.getByText("Stopping…")).toBeTruthy()

    const assistantMessage = {
      id: "assistant-tool-abort",
      role: "assistant",
      parts: [{ type: "tool-market_get_quote", toolCallId: "call-1", state: "input-available", input: {} }],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: true,
    }))
    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()
  })

  it("ignores a late successful completion from the cancelled generation", async () => {
    renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    const assistantMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Late answer" }],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: true,
    }))

    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()

    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: false,
    }))

    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()
    expect(screen.queryByText("Complete")).toBeNull()
  })

  it("keeps navigation cleanup resumable and non-cancelling", () => {
    const { unmount } = renderConnectedChat()

    expect(hook.options?.cancelOnClientAbort).toBe(false)
    unmount()

    expect(hook.state.stop).not.toHaveBeenCalled()
  })
})
