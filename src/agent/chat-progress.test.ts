import { describe, expect, it } from "vitest"
import {
  initialChatProgressState,
  reduceChatProgress,
  reduceChatProgressEvents,
} from "./chat-progress"
import type { ChatProgressEvent } from "./chat-message"

function event(
  ordinal: number,
  overrides: Partial<ChatProgressEvent> = {},
): ChatProgressEvent {
  return {
    version: 1,
    eventId: `run-1:${ordinal}`,
    runId: "run-1",
    ordinal,
    activityId: ordinal === 0 ? "run" : "model",
    phase: ordinal === 0 ? "preparing" : "waiting",
    status: "active",
    label: ordinal === 0 ? "Request" : "Model",
    message: ordinal === 0 ? "Preparing your request…" : "Waiting for the model…",
    ...overrides,
  }
}

describe("chat progress reducer", () => {
  it("deduplicates reconnect replay and rejects stale regression", () => {
    const waiting = event(0)
    const composing = event(1, { activityId: "run", phase: "composing", message: "Composing the answer…" })
    const state = reduceChatProgressEvents([waiting, composing, waiting, composing])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]?.phase).toBe("composing")
    expect(state.lastOrdinal).toBe(1)
  })

  it("keeps tool failures local while allowing the run to recover", () => {
    const failedTool = event(1, {
      activityId: "tool:call-1",
      phase: "tool",
      status: "failed",
      label: "Quote",
      message: "Tool failed",
    })
    const recovered = event(2, {
      activityId: "recovery",
      phase: "recovering",
      message: "Recovering the response…",
    })
    const state = reduceChatProgressEvents([event(0), failedTool, recovered])

    expect(state.terminalStatus).toBeNull()
    expect(state.rows.find((row) => row.activityId === "tool:call-1")?.status).toBe("failed")
    expect(state.rows.find((row) => row.activityId === "recovery")?.status).toBe("active")
  })

  it.each(["completed", "cancelled", "failed"] as const)("seals active rows on %s", (status) => {
    const terminal = event(2, {
      activityId: "run",
      phase: status,
      status,
      label: status,
      message: status,
    })
    const sealed = reduceChatProgressEvents([event(0), terminal])
    const afterTerminal = reduceChatProgress(sealed, event(3, { phase: "waiting" }))

    expect(sealed.terminalStatus).toBe(status)
    expect(sealed.rows.every((row) => row.status !== "active")).toBe(true)
    expect(afterTerminal).toBe(sealed)
  })

  it("ignores malformed and cross-run data", () => {
    const state = reduceChatProgressEvents([null, {}, event(0), event(1, { runId: "run-2" })])
    expect(state.runId).toBe("run-1")
    expect(state.lastOrdinal).toBe(0)
    expect(reduceChatProgress(initialChatProgressState, event(0)).rows).toHaveLength(1)
  })

  it("switches only on a fresh unseen run and never regresses to an old run", () => {
    const run1Start = event(0)
    const run2Start = event(0, { eventId: "run-2:0", runId: "run-2" })
    const run2Waiting = event(1, { eventId: "run-2:1", runId: "run-2" })
    const staleRun1Restart = event(0)
    const state = reduceChatProgressEvents([run1Start, run2Start, run2Waiting, staleRun1Restart])

    expect(state.runId).toBe("run-2")
    expect(state.lastOrdinal).toBe(1)
    expect(state.seenRunIds).toEqual(["run-1", "run-2"])
  })

  it("rejects a different run that does not begin with preparing ordinal zero", () => {
    const state = reduceChatProgressEvents([
      event(0),
      event(1, { eventId: "run-2:1", runId: "run-2", phase: "waiting" }),
    ])
    expect(state.runId).toBe("run-1")
  })
})
