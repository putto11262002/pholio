import { describe, expect, it } from "vitest"
import {
  beginTurn,
  cancelTurn,
  clearTurnCompletion,
  completeTurn,
  continueTurn,
  createTurnGenerationQueue,
  createSelectionIntentTracker,
  initialTurnGenerationState,
  latestTurnGeneration,
  requestTurnCancellation,
  resolveChatLifecycle,
  retryTurn,
  settleTurnCancellation,
} from "./chat-lifecycle"

const baseLifecycle = {
  connectionState: "connected" as const,
  status: "ready" as const,
  isStreaming: false,
  isRecovering: false,
  isToolContinuation: false,
  isStopping: false,
  hasCompletedTurn: false,
  wasCancelled: false,
  hasError: false,
}

describe("resolveChatLifecycle", () => {
  it.each([
    [{ connectionState: "connecting" as const }, "connecting"],
    [{ status: "submitted" as const }, "waiting"],
    [{ status: "streaming" as const, isStreaming: true }, "streaming"],
    [{ isRecovering: true }, "recovering"],
    [{ isToolContinuation: true, isStreaming: true }, "continuing"],
    [{ isStopping: true, status: "ready" as const }, "stopping"],
    [{ hasCompletedTurn: true }, "completed"],
    [
      { wasCancelled: true, hasCompletedTurn: true, hasError: true },
      "cancelled",
    ],
    [{ hasError: true, isStreaming: true }, "failed"],
  ])("maps %o to %s", (overrides, expected) => {
    expect(resolveChatLifecycle({ ...baseLifecycle, ...overrides })).toBe(
      expected
    )
  })

  it("shows recovery when a running turn loses its connection", () => {
    expect(
      resolveChatLifecycle({
        ...baseLifecycle,
        connectionState: "reconnecting",
        isStreaming: true,
      })
    ).toBe("recovering")
  })
})

describe("createSelectionIntentTracker", () => {
  it("prevents a stale thread creation from stealing a newer selection", () => {
    const tracker = createSelectionIntentTracker()
    const createIntent = tracker.supersede()

    tracker.supersede()

    expect(tracker.isCurrent(createIntent)).toBe(false)
  })

  it("allows the current creation result to select its thread", () => {
    const tracker = createSelectionIntentTracker()
    const createIntent = tracker.supersede()

    expect(tracker.isCurrent(createIntent)).toBe(true)
  })

})

describe("turn generations", () => {
  it("ignores a late abort from the stopped turn after an immediate new send", () => {
    const firstTurn = beginTurn(initialTurnGenerationState)
    const completions = createTurnGenerationQueue()
    completions.enqueue(firstTurn.current)
    const stopping = requestTurnCancellation(firstTurn, firstTurn.current)
    const locallyAborted = cancelTurn(stopping, firstTurn.current)
    const stopped = settleTurnCancellation(locallyAborted, firstTurn.current)
    const secondTurn = beginTurn(stopped)
    completions.enqueue(secondTurn.current)

    const lateOldAbort = cancelTurn(secondTurn, completions.resolve()!)

    expect(lateOldAbort).toEqual(secondTurn)
    expect(lateOldAbort.cancelled).toBeNull()
    expect(completions.resolve()).toBe(secondTurn.current)
  })

  it("uses message metadata to correlate out-of-order turn completions", () => {
    const completions = createTurnGenerationQueue()
    const firstTurn = beginTurn(initialTurnGenerationState)
    const secondTurn = beginTurn(firstTurn)
    completions.enqueue(firstTurn.current)
    completions.enqueue(secondTurn.current)

    const secondCompletion = completions.resolve(secondTurn.current)!
    const completed = completeTurn(secondTurn, secondCompletion)
    const lateFirstAbort = completions.resolve(firstTurn.current)!

    expect(secondCompletion).toBe(secondTurn.current)
    expect(cancelTurn(completed, lateFirstAbort)).toEqual(completed)
    expect(completed.cancelled).toBeNull()
    expect(completed.completed).toBe(secondTurn.current)
  })

  it("retries on the reused user-message generation and clears its queue entry", () => {
    const completions = createTurnGenerationQueue()
    const failedTurn = beginTurn(initialTurnGenerationState)
    completions.enqueue(failedTurn.current)

    const retry = retryTurn(failedTurn)
    completions.enqueue(retry.current)
    const retryCompletion = completions.resolve(failedTurn.current)!
    const completed = completeTurn(retry, retryCompletion)

    expect(retry.current).toBe(failedTurn.current)
    expect(completed.completed).toBe(retry.current)
    expect(completions.resolve()).toBeUndefined()
  })

  it("creates a safe first generation when retry has no current turn", () => {
    expect(retryTurn(initialTurnGenerationState).current).toBe(1)
  })

  it("only marks completion for the current turn", () => {
    const openedHistoricalThread = initialTurnGenerationState
    expect(openedHistoricalThread.completed).toBeNull()

    const current = beginTurn(openedHistoricalThread)
    expect(completeTurn(current, current.current).completed).toBe(current.current)
    expect(completeTurn(current, current.current - 1)).toEqual(current)
  })

  it("requires both local abort and server settlement before cancellation is terminal", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)

    expect(stopping.stopping).toBe(running.current)
    expect(stopping.cancelled).toBeNull()
    expect(cancelTurn(running, running.current)).toEqual(running)
    const locallyAborted = cancelTurn(stopping, stopping.current)
    expect(locallyAborted).toMatchObject({
      stopping: stopping.current,
      abortAcknowledged: stopping.current,
      cancelled: null,
    })
    expect(settleTurnCancellation(locallyAborted, stopping.current)).toMatchObject({
      stopping: null,
      serverSettled: stopping.current,
      cancelled: stopping.current,
    })
  })

  it("also waits for the local abort when server settlement arrives first", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const serverSettled = settleTurnCancellation(stopping, stopping.current)

    expect(serverSettled).toMatchObject({
      stopping: stopping.current,
      serverSettled: stopping.current,
      cancelled: null,
    })
    expect(cancelTurn(serverSettled, stopping.current)).toMatchObject({
      stopping: null,
      cancelled: stopping.current,
    })
  })

  it("holds a normal finish behind the settlement barrier", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const finished = completeTurn(stopping, stopping.current)

    expect(finished).toMatchObject({
      stopping: stopping.current,
      completionAcknowledged: stopping.current,
      completed: null,
    })
    expect(settleTurnCancellation(finished, stopping.current)).toMatchObject({
      stopping: null,
      completed: stopping.current,
    })
  })

  it("terminalizes a normal finish that arrives after server settlement", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const serverSettled = settleTurnCancellation(stopping, stopping.current)

    expect(serverSettled.stopping).toBe(stopping.current)
    expect(completeTurn(serverSettled, stopping.current)).toMatchObject({
      stopping: null,
      completionAcknowledged: stopping.current,
      completed: stopping.current,
    })
  })

  it("keeps the first local terminal acknowledgement when late events disagree", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const finished = completeTurn(stopping, stopping.current)
    const lateAbort = cancelTurn(finished, stopping.current)
    expect(lateAbort).toEqual(finished)

    const aborted = cancelTurn(stopping, stopping.current)
    expect(completeTurn(aborted, stopping.current)).toEqual(aborted)
  })

  it("preserves a completion recorded just before Stop until settlement", () => {
    const running = beginTurn(initialTurnGenerationState)
    const completed = completeTurn(running, running.current)
    const stopping = requestTurnCancellation(completed, completed.current)

    expect(stopping).toMatchObject({
      stopping: completed.current,
      completionAcknowledged: completed.current,
      completed: completed.current,
    })
    expect(settleTurnCancellation(stopping, completed.current)).toMatchObject({
      stopping: null,
      completed: completed.current,
    })
  })

  it("clears prior completion when a genuine continuation starts", () => {
    const running = beginTurn(initialTurnGenerationState)
    const completed = completeTurn(running, running.current)

    expect(continueTurn(completed)).toMatchObject({
      current: completed.current,
      completionAcknowledged: null,
      completed: null,
    })
  })

  it("clears only stale completion while a bridged continuation is active", () => {
    const running = beginTurn(initialTurnGenerationState)
    const completed = completeTurn(running, running.current)
    const stopping = settleTurnCancellation(
      requestTurnCancellation(completed, completed.current),
      completed.current,
    )

    expect(clearTurnCompletion(stopping, stopping.current)).toMatchObject({
      stopping: null,
      serverSettled: stopping.current,
      completionAcknowledged: null,
      completed: null,
    })
  })

  it("ignores late completion after abort acknowledgement and cancellation", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const locallyAborted = cancelTurn(stopping, stopping.current)
    const cancelled = settleTurnCancellation(
      locallyAborted,
      stopping.current,
    )

    expect(completeTurn(locallyAborted, stopping.current)).toEqual(locallyAborted)
    expect(completeTurn(cancelled, cancelled.current)).toEqual(cancelled)
  })

  it("allows a fresh generation only after cancellation is terminal", () => {
    const running = beginTurn(initialTurnGenerationState)
    const stopping = requestTurnCancellation(running, running.current)
    const cancelled = settleTurnCancellation(
      cancelTurn(stopping, stopping.current),
      stopping.current,
    )
    const next = beginTurn(cancelled)

    expect(next.current).toBe(cancelled.current + 1)
    expect(next.stopping).toBeNull()
    expect(next.cancelled).toBeNull()
  })

  it("does not treat navigation or disconnect cleanup as explicit cancellation", () => {
    const running = beginTurn(initialTurnGenerationState)

    expect(cancelTurn(running, running.current)).toEqual(running)
  })

  it("recovers the active generation from persisted messages after reload", () => {
    expect(latestTurnGeneration([
      { role: "user", metadata: { turnGeneration: 3 } },
      { role: "assistant" },
      { role: "user", metadata: { turnGeneration: 4 } },
    ])).toBe(4)
  })
})
