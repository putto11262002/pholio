import type { ChatProgressEvent, ChatProgressStatus } from "@/agent/chat-message"

export type ChatProgressRow = ChatProgressEvent

export type ChatProgressState = {
  runId: string | null
  seenRunIds: Array<string>
  lastOrdinal: number
  seenEventIds: Array<string>
  rows: Array<ChatProgressRow>
  terminalStatus: Exclude<ChatProgressStatus, "active"> | null
}

export const initialChatProgressState: ChatProgressState = {
  runId: null,
  seenRunIds: [],
  lastOrdinal: -1,
  seenEventIds: [],
  rows: [],
  terminalStatus: null,
}

const terminalStatuses = new Set<ChatProgressStatus>(["completed", "cancelled", "failed"])
const progressPhases = new Set([
  "preparing",
  "waiting",
  "tool",
  "provisioning",
  "uploading",
  "running",
  "reading",
  "recovering",
  "composing",
  "completed",
  "cancelled",
  "failed",
])

export function isChatProgressEvent(value: unknown): value is ChatProgressEvent {
  if (typeof value !== "object" || value === null) return false
  const event = value as Partial<ChatProgressEvent>
  return event.version === 1
    && typeof event.eventId === "string"
    && event.eventId.length > 0
    && typeof event.runId === "string"
    && event.runId.length > 0
    && typeof event.ordinal === "number"
    && Number.isSafeInteger(event.ordinal)
    && event.ordinal >= 0
    && typeof event.activityId === "string"
    && event.activityId.length > 0
    && typeof event.phase === "string"
    && progressPhases.has(event.phase)
    && typeof event.status === "string"
    && (event.status === "active" || terminalStatuses.has(event.status))
    && typeof event.label === "string"
    && event.label.length > 0
    && typeof event.message === "string"
    && event.message.length > 0
}

/**
 * Applies one durable progress event. Replays, stale ordinals, cross-run data,
 * and updates after a terminal event are ignored so the UI can only advance.
 */
export function reduceChatProgress(
  state: ChatProgressState,
  event: ChatProgressEvent,
): ChatProgressState {
  const freshStart = event.ordinal === 0
    && event.phase === "preparing"
    && event.status === "active"
  if (state.runId === null && !freshStart) return state
  if (state.runId !== null && event.runId !== state.runId) {
    if (!freshStart || state.seenRunIds.includes(event.runId)) return state
    return reduceChatProgress({
      ...initialChatProgressState,
      seenRunIds: [...state.seenRunIds, event.runId],
    }, event)
  }
  if (state.seenEventIds.includes(event.eventId)) return state
  if (event.ordinal <= state.lastOrdinal) return state
  if (state.terminalStatus !== null) return state

  let terminalStatus: Exclude<ChatProgressStatus, "active"> | null = null
  if (event.phase === "completed" || event.phase === "cancelled" || event.phase === "failed") {
    terminalStatus = event.phase
  }
  const rows = state.rows.map((row) => {
    if (terminalStatus && row.status === "active") return { ...row, status: terminalStatus }
    return row
  })
  const nextEvent = terminalStatus && event.status !== terminalStatus
    ? { ...event, status: terminalStatus }
    : event
  const rowIndex = rows.findIndex((row) => row.activityId === event.activityId)
  if (rowIndex === -1) rows.push(nextEvent)
  else rows[rowIndex] = nextEvent

  return {
    runId: state.runId ?? event.runId,
    seenRunIds: state.seenRunIds.includes(event.runId)
      ? state.seenRunIds
      : [...state.seenRunIds, event.runId],
    lastOrdinal: event.ordinal,
    seenEventIds: [...state.seenEventIds, event.eventId],
    rows,
    terminalStatus,
  }
}

export function reduceChatProgressEvents(events: ReadonlyArray<unknown>): ChatProgressState {
  return events.reduce<ChatProgressState>(
    (state, value) => isChatProgressEvent(value) ? reduceChatProgress(state, value) : state,
    initialChatProgressState,
  )
}
