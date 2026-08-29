export type ChatConnectionState = "connecting" | "connected" | "reconnecting"

export type ChatLifecycleState =
  | "connecting"
  | "waiting"
  | "streaming"
  | "recovering"
  | "continuing"
  | "completed"
  | "cancelled"
  | "failed"
  | "idle"

export type ChatLifecycleInput = {
  connectionState: ChatConnectionState
  status: "submitted" | "streaming" | "ready" | "error"
  isStreaming: boolean
  isRecovering: boolean
  isToolContinuation: boolean
  hasCompletedTurn: boolean
  wasCancelled: boolean
  hasError: boolean
}

export function resolveChatLifecycle(
  input: ChatLifecycleInput
): ChatLifecycleState {
  if (input.wasCancelled) return "cancelled"
  if (input.hasError || input.status === "error") return "failed"
  if (input.isRecovering) return "recovering"
  if (input.connectionState !== "connected") {
    return input.connectionState === "reconnecting" || input.isStreaming
      ? "recovering"
      : "connecting"
  }
  if (input.isToolContinuation) return "continuing"
  if (input.status === "submitted") return "waiting"
  if (input.isStreaming || input.status === "streaming") return "streaming"
  if (input.hasCompletedTurn) return "completed"
  return "idle"
}

export function createSelectionIntentTracker() {
  let current = 0

  return {
    capture() {
      return current
    },
    supersede() {
      current += 1
      return current
    },
    isCurrent(intent: number) {
      return intent === current
    },
  }
}

export async function resolveCreatedThreadIntent({
  id,
  intent,
  tracker,
  select,
  remove,
}: {
  id: string
  intent: number
  tracker: ReturnType<typeof createSelectionIntentTracker>
  select: (id: string) => void
  remove: (id: string) => Promise<unknown>
}) {
  if (tracker.isCurrent(intent)) {
    select(id)
    return "selected" as const
  }
  await remove(id)
  return "removed" as const
}

export type TurnGenerationState = {
  current: number
  cancelled: number | null
  completed: number | null
}

export const initialTurnGenerationState: TurnGenerationState = {
  current: 0,
  cancelled: null,
  completed: null,
}

export function beginTurn(state: TurnGenerationState): TurnGenerationState {
  return { current: state.current + 1, cancelled: null, completed: null }
}

export function retryTurn(state: TurnGenerationState): TurnGenerationState {
  return state.current > 0
    ? { ...state, cancelled: null, completed: null }
    : beginTurn(state)
}

export function cancelTurn(state: TurnGenerationState, generation: number): TurnGenerationState {
  return generation === state.current ? { ...state, cancelled: generation, completed: null } : state
}

export function completeTurn(state: TurnGenerationState, generation: number): TurnGenerationState {
  return generation === state.current ? { ...state, cancelled: null, completed: generation } : state
}

export function turnGenerationForFinishedMessage(
  messageId: string,
  messages: Array<{ id: string; role: string; metadata?: { turnGeneration?: number } }>,
): number | undefined {
  const messageIndex = messages.findIndex((message) => message.id === messageId)
  if (messageIndex < 0) return undefined
  for (let index = messageIndex; index >= 0; index -= 1) {
    const generation = messages[index].metadata?.turnGeneration
    if (messages[index].role === "user" && generation !== undefined) return generation
  }
  return undefined
}

export function latestTurnGeneration(
  messages: Array<{ role: string; metadata?: { turnGeneration?: number } }>,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const generation = messages[index].metadata?.turnGeneration
    if (messages[index].role === "user" && generation !== undefined) return generation
  }
  return undefined
}

export function createTurnGenerationQueue() {
  const pending: Array<number> = []
  return {
    enqueue(generation: number) {
      if (!pending.includes(generation)) pending.push(generation)
    },
    resolve(fallback?: number) {
      if (fallback !== undefined) {
        const matchingIndex = pending.indexOf(fallback)
        if (matchingIndex >= 0) pending.splice(matchingIndex, 1)
        return fallback
      }
      return pending.shift()
    },
  }
}
