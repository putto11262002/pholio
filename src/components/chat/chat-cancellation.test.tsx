// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@/agent/chat-message"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

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
  call: vi.fn(async (): Promise<{ status: "stable" | "timeout" | "unavailable" }> => ({ status: "stable" })),
}))

vi.mock("agents/react", async () => {
  const { useEffect } = await import("react")
  return {
    useAgent: (options: { onOpen?: () => void }) => {
      useEffect(() => { options.onOpen?.() }, [options.onOpen])
      return agent
    },
  }
})

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
  return render(connectedChatElement())
}

function connectedChatElement() {
  return (
    <ConnectedChat
      threadId="thread-1"
      modelKey="flash"
      providerOptions={{}}
      activeTitle="Analysis"
      onModelSelect={() => undefined}
      onThinkingSelect={() => undefined}
      onAutoTitle={() => undefined}
    />
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

    await act(async () => { await stop.mock.results[0]?.value })

    expect(agent.call).toHaveBeenCalledWith("waitForTurnSettlement", [], { timeout: 12_000 })
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
    await act(async () => {
      hook.options?.onFinish({
        message: assistantMessage,
        messages: [userMessage, assistantMessage],
        isAbort: true,
      })
      await (hook.state.stop as ReturnType<typeof vi.fn>).mock.results[0]?.value
    })

    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()

    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: false,
    }))

    expect(screen.getByText("Cancelled — partial response kept.")).toBeTruthy()
    expect(screen.queryByText("Complete")).toBeNull()
  })

  it("keeps input disabled and surfaces recovery when settlement times out", async () => {
    agent.call.mockResolvedValueOnce({ status: "timeout" })
    renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    const emptyAssistant = { id: "assistant-empty", role: "assistant", parts: [] } as ChatMessage
    await act(async () => {
      hook.options?.onFinish({ message: emptyAssistant, messages: [emptyAssistant], isAbort: true })
      await (hook.state.stop as ReturnType<typeof vi.fn>).mock.results[0]?.value
    })

    expect(screen.getByRole("alert").textContent).toContain("server is still stopping")
    expect(screen.queryByText("Cancelled — partial response kept.")).toBeNull()
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByRole("button", { name: /Try stop again/ })).toBeTruthy()
  })

  it("holds a racing normal finish until the server settlement barrier resolves", async () => {
    const settlement = deferred<{ status: "stable" | "timeout" | "unavailable" }>()
    agent.call.mockReturnValueOnce(settlement.promise)
    hook.state = { ...hook.state, status: "ready", isStreaming: true }
    const view = renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    const assistantMessage = {
      id: "assistant-normal-finish",
      role: "assistant",
      parts: [{ type: "text", text: "Finished at the boundary" }],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: false,
    }))
    hook.state = { ...hook.state, status: "ready", isStreaming: false }
    view.rerender(connectedChatElement())

    expect(screen.getByText("Stopping…")).toBeTruthy()
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(true)

    await act(async () => { settlement.resolve({ status: "stable" }); await settlement.promise })

    await waitFor(() => expect(screen.getByText("Complete")).toBeTruthy())
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(false)
  })

  it("classifies the interrupted transport emitted by Stop as cancellation", async () => {
    const settlement = deferred<{ status: "stable" | "timeout" | "unavailable" }>()
    agent.call.mockReturnValueOnce(settlement.promise)
    hook.state = { ...hook.state, status: "streaming", isStreaming: true }
    const view = renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    const partialAssistant = {
      id: "assistant-interrupted",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: partialAssistant,
      messages: [userMessage, partialAssistant],
      isAbort: false,
    }))

    hook.state = {
      ...hook.state,
      status: "error",
      isStreaming: false,
      error: new Error("The response ended unexpectedly."),
    }
    view.rerender(connectedChatElement())
    expect(screen.getByRole("alert").textContent).toContain("response ended unexpectedly")
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(true)

    await act(async () => {
      settlement.resolve({ status: "stable" })
      await settlement.promise
    })

    await waitFor(() => expect(
      screen.getByText("Cancelled — partial response kept."),
    ).toBeTruthy())
    expect(hook.state.clearError).toHaveBeenCalledOnce()
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(false)

    hook.state = { ...hook.state, status: "ready", error: null }
    view.rerender(connectedChatElement())
    fireEvent.change(screen.getByPlaceholderText("Ask about your portfolio…"), {
      target: { value: "Follow up" },
    })
    fireEvent.keyDown(screen.getByPlaceholderText("Ask about your portfolio…"), {
      key: "Enter",
      shiftKey: false,
    })
    expect(hook.state.sendMessage).toHaveBeenCalledWith({
      text: "Follow up",
      metadata: { turnGeneration: 2 },
    })
  })

  it("reclassifies a boundary finish when the transport failure arrives after settlement", async () => {
    hook.state = { ...hook.state, status: "streaming", isStreaming: true }
    const view = renderConnectedChat()

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    const partialAssistant = {
      id: "assistant-late-transport-failure",
      role: "assistant",
      parts: [{ type: "text", text: "Partial answer" }],
    } as ChatMessage
    await act(async () => {
      hook.options?.onFinish({
        message: partialAssistant,
        messages: [userMessage, partialAssistant],
        isAbort: false,
      })
      await (hook.state.stop as ReturnType<typeof vi.fn>).mock.results[0]?.value
    })

    hook.state = { ...hook.state, status: "ready", isStreaming: false }
    view.rerender(connectedChatElement())
    await waitFor(() => expect(screen.getByText("Complete")).toBeTruthy())

    hook.state = {
      ...hook.state,
      status: "error",
      error: new Error("The response ended unexpectedly."),
    }
    view.rerender(connectedChatElement())

    await waitFor(() => expect(
      screen.getByText("Cancelled — partial response kept."),
    ).toBeTruthy())
    expect(hook.state.clearError).toHaveBeenCalledOnce()
  })

  it("preserves a normal finish recorded just before a stale Stop click", async () => {
    hook.state = { ...hook.state, status: "streaming", isStreaming: true }
    renderConnectedChat()
    const assistantMessage = {
      id: "assistant-already-finished",
      role: "assistant",
      parts: [{ type: "text", text: "Already finished" }],
    } as ChatMessage

    act(() => hook.options?.onFinish({
      message: assistantMessage,
      messages: [userMessage, assistantMessage],
      isAbort: false,
    }))
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    hook.state = { ...hook.state, status: "ready", isStreaming: false }

    await waitFor(() => expect(screen.getByText("Complete")).toBeTruthy())
    expect(agent.call).toHaveBeenCalledWith("waitForTurnSettlement", [], { timeout: 12_000 })
    expect((screen.getByPlaceholderText("Ask about your portfolio…") as HTMLTextAreaElement).disabled).toBe(false)
  })

  it("cancels a bridged continuation instead of preserving the original completion", async () => {
    hook.state = { ...hook.state, status: "streaming", isStreaming: true, isToolContinuation: false }
    const view = renderConnectedChat()

    hook.state = { ...hook.state, isToolContinuation: true }
    view.rerender(connectedChatElement())
    const originalAssistant = {
      id: "assistant-original-finish",
      role: "assistant",
      parts: [{ type: "text", text: "Original stream finished" }],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: originalAssistant,
      messages: [userMessage, originalAssistant],
      isAbort: false,
    }))

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    await waitFor(() => expect(agent.call).toHaveBeenCalledWith(
      "waitForTurnSettlement",
      [],
      { timeout: 12_000 },
    ))
    expect(screen.getByText("Stopping…")).toBeTruthy()

    const abortedContinuation = {
      id: "assistant-continuation-abort",
      role: "assistant",
      parts: [],
    } as ChatMessage
    act(() => hook.options?.onFinish({
      message: abortedContinuation,
      messages: [userMessage, abortedContinuation],
      isAbort: true,
    }))
    hook.state = { ...hook.state, status: "ready", isStreaming: false, isToolContinuation: false }
    view.rerender(connectedChatElement())

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
