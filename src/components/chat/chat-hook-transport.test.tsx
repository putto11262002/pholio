// @vitest-environment jsdom

import { useEffect } from "react"
import { useAgentChat } from "@cloudflare/ai-chat/react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatMessage } from "@/agent/chat-message"

type SentFrame = {
  id?: string
  type: string
  init?: { body?: string }
}

class FakeAgent extends EventTarget {
  readonly agent = "chat"
  readonly connectionError = null
  readonly path = undefined
  readonly sent: SentFrame[] = []
  readonly _pk: string

  constructor(readonly name: string) {
    super()
    this._pk = `pk-${name}`
  }

  getHttpUrl() {
    return null
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as SentFrame)
  }
}

type HookControls = {
  sendMessage: (input: { text: string }) => void
  stop: () => Promise<void>
}

function HookHarness({
  agent,
  messages,
  onReady,
}: {
  agent: FakeAgent
  messages: ChatMessage[]
  onReady: (controls: HookControls) => void
}) {
  const chat = useAgentChat<unknown, ChatMessage>({
    agent: agent as never,
    messages,
    getInitialMessages: null,
    resume: false,
    cancelOnClientAbort: false,
  })

  useEffect(() => {
    onReady({
      sendMessage: (input) => {
        void chat.sendMessage(input)
      },
      stop: chat.stop,
    })
  }, [chat.sendMessage, chat.stop, onReady])
  return null
}

function requestFrames(agent: FakeAgent) {
  return agent.sent.filter((frame) => frame.type === "cf_agent_use_chat_request")
}

function cancelFrames(agent: FakeAgent) {
  return agent.sent.filter((frame) => frame.type === "cf_agent_chat_request_cancel")
}

afterEach(cleanup)

describe("useAgentChat transport contract", () => {
  it("sends the explicit cancellation frame while client cleanup remains non-cancelling", async () => {
    const explicitAgent = new FakeAgent("explicit-stop")
    let explicitControls: HookControls | undefined
    const explicit = render(
      <HookHarness
        agent={explicitAgent}
        messages={[]}
        onReady={(controls) => { explicitControls = controls }}
      />,
    )

    await waitFor(() => expect(explicitControls).toBeDefined())
    act(() => explicitControls?.sendMessage({ text: "cancel this" }))
    await waitFor(() => expect(requestFrames(explicitAgent)).toHaveLength(1))
    await act(async () => {
      await explicitControls?.stop()
    })

    expect(cancelFrames(explicitAgent)).toEqual([{
      id: requestFrames(explicitAgent)[0]?.id,
      type: "cf_agent_chat_request_cancel",
    }])
    explicit.unmount()

    const navigationAgent = new FakeAgent("navigation")
    let navigationControls: HookControls | undefined
    const navigation = render(
      <HookHarness
        agent={navigationAgent}
        messages={[]}
        onReady={(controls) => { navigationControls = controls }}
      />,
    )
    await waitFor(() => expect(navigationControls).toBeDefined())
    act(() => navigationControls?.sendMessage({ text: "keep running" }))
    await waitFor(() => expect(requestFrames(navigationAgent)).toHaveLength(1))

    navigation.unmount()

    expect(cancelFrames(navigationAgent)).toHaveLength(0)
  })

  it("serializes only the new hook transcript after a thread remount", async () => {
    const oldAgent = new FakeAgent("old-thread")
    const newAgent = new FakeAgent("new-thread")
    const oldTranscript = [{
      id: "old-user",
      role: "user",
      parts: [{ type: "text", text: "old secret context" }],
    } as ChatMessage]
    let controls: HookControls | undefined
    const onReady = (next: HookControls) => { controls = next }
    const view = render(
      <HookHarness key="old" agent={oldAgent} messages={oldTranscript} onReady={onReady} />,
    )

    await waitFor(() => expect(controls).toBeDefined())
    controls = undefined
    view.rerender(
      <HookHarness key="new" agent={newAgent} messages={[]} onReady={onReady} />,
    )
    await waitFor(() => expect(controls).toBeDefined())
    act(() => controls?.sendMessage({ text: "fresh prompt only" }))
    await waitFor(() => expect(requestFrames(newAgent)).toHaveLength(1))

    const request = requestFrames(newAgent)[0]
    const body = JSON.parse(request?.init?.body ?? "{}") as { messages?: ChatMessage[] }
    expect(JSON.stringify(body.messages)).toContain("fresh prompt only")
    expect(JSON.stringify(body.messages)).not.toContain("old secret context")
    expect(requestFrames(oldAgent)).toHaveLength(0)
  })
})
