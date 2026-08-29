// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Message } from "./chat-panel"
import type { ChatMessage, ChatProgressEvent } from "@/agent/chat-message"

function progressEvent(overrides: Partial<ChatProgressEvent> = {}): ChatProgressEvent {
  return {
    version: 1,
    eventId: "run-1:0",
    runId: "run-1",
    ordinal: 0,
    activityId: "run",
    phase: "preparing",
    status: "active",
    label: "Request",
    message: "Preparing your request…",
    ...overrides,
  }
}

afterEach(cleanup)

describe("chat progress presentation", () => {
  it("prefers typed progress and never renders persisted reasoning", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "private old reasoning", state: "done" },
        { type: "reasoning-file", mediaType: "text/plain", url: "data:text/plain,private" },
        { type: "data-chat-progress", data: progressEvent() },
        { type: "data-chat-progress", data: progressEvent({
          eventId: "run-1:1",
          ordinal: 1,
          phase: "completed",
          status: "completed",
          label: "Done",
          message: "Answer complete",
        }) },
        { type: "tool-market_get_quote", toolCallId: "call-1", state: "input-streaming", input: {} },
        { type: "text", text: "Final answer", state: "done" },
      ],
    } as ChatMessage

    render(<Message message={message} isStreaming={false} />)

    expect(screen.getByText("Work complete")).toBeTruthy()
    expect(screen.getByText("Final answer")).toBeTruthy()
    expect(screen.queryByText(/private old reasoning/i)).toBeNull()
    expect(screen.queryByText(/looking up a quote/i)).toBeNull()
  })

  it("keeps the safe legacy tool fallback when progress is absent", () => {
    const message = {
      id: "assistant-2",
      role: "assistant",
      parts: [
        { type: "tool-market_get_quote", toolCallId: "call-2", state: "input-streaming", input: {} },
      ],
    } as ChatMessage

    render(<Message message={message} isStreaming />)

    expect(screen.getByText("Looking up a quote…")).toBeTruthy()
    expect(document.body.textContent).not.toContain("undefined")
  })

  it("renders a durable nonterminal rail as interrupted when no stream is active", () => {
    const message = {
      id: "assistant-3",
      role: "assistant",
      parts: [
        { type: "data-chat-progress", data: progressEvent() },
      ],
    } as ChatMessage

    const { container } = render(<Message message={message} isStreaming={false} />)

    expect(screen.getByText("Response interrupted")).toBeTruthy()
    expect(screen.queryByText("Work complete")).toBeNull()
    expect(container.querySelector('[data-chat-progress="interrupted"]')).toBeTruthy()
    expect(container.querySelector('[data-chat-progress="completed"]')).toBeNull()
    expect(container.querySelector("svg.lucide-circle-check-big")).toBeNull()
  })
})
