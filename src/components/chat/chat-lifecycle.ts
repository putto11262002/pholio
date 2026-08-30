export type ChatConnectionState = "connecting" | "connected" | "reconnecting"

export type ChatLifecycleState =
  | "connecting"
  | "waiting"
  | "streaming"
  | "recovering"
  | "continuing"
  | "stopping"
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
  isStopping: boolean
  hasCompletedTurn: boolean
  wasCancelled: boolean
  hasError: boolean
}

export function resolveChatLifecycle(
  input: ChatLifecycleInput
): ChatLifecycleState {
  if (input.isStopping) return "stopping"
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

export type TurnGenerationState = {
  current: number
  stopping: number | null
  abortAcknowledged: number | null
  completionAcknowledged: number | null
  serverSettled: number | null
  cancelled: number | null
  completed: number | null
}

export const initialTurnGenerationState: TurnGenerationState = {
  current: 0,
  stopping: null,
  abortAcknowledged: null,
  completionAcknowledged: null,
  serverSettled: null,
  cancelled: null,
  completed: null,
}

export function beginTurn(state: TurnGenerationState): TurnGenerationState {
  return {
    current: state.current + 1,
    stopping: null,
    abortAcknowledged: null,
    completionAcknowledged: null,
    serverSettled: null,
    cancelled: null,
    completed: null,
  }
}

export function retryTurn(state: TurnGenerationState): TurnGenerationState {
  return state.current > 0
    ? {
        ...state,
        stopping: null,
        abortAcknowledged: null,
        completionAcknowledged: null,
        serverSettled: null,
        cancelled: null,
        completed: null,
      }
    : beginTurn(state)
}

export function continueTurn(state: TurnGenerationState): TurnGenerationState {
  return {
    ...state,
    abortAcknowledged: null,
    completionAcknowledged: null,
    serverSettled: null,
    cancelled: null,
    completed: null,
  }
}

export function clearTurnCompletion(
  state: TurnGenerationState,
  generation: number,
): TurnGenerationState {
  return generation === state.current
    ? { ...state, completionAcknowledged: null, completed: null }
    : state
}

export function requestTurnCancellation(state: TurnGenerationState, generation: number): TurnGenerationState {
  return generation === state.current && state.cancelled !== generation
    ? {
        ...state,
        stopping: generation,
        abortAcknowledged: state.stopping === generation ? state.abortAcknowledged : null,
        completionAcknowledged: state.stopping === generation
          ? state.completionAcknowledged
          : state.completed === generation ? generation : null,
        serverSettled: state.stopping === generation ? state.serverSettled : null,
      }
    : state
}

export function cancelTurn(state: TurnGenerationState, generation: number): TurnGenerationState {
  if (generation !== state.current || state.stopping !== generation) return state
  if (state.completionAcknowledged === generation) return state
  return state.serverSettled === generation
    ? { ...state, stopping: null, abortAcknowledged: generation, cancelled: generation, completed: null }
    : { ...state, abortAcknowledged: generation, completed: null }
}

export function settleTurnCancellation(
  state: TurnGenerationState,
  generation: number,
): TurnGenerationState {
  if (generation !== state.current || state.stopping !== generation) return state
  if (state.completionAcknowledged === generation) {
    return { ...state, stopping: null, serverSettled: generation, completed: generation }
  }
  return state.abortAcknowledged === generation
    ? { ...state, stopping: null, serverSettled: generation, cancelled: generation, completed: null }
    : { ...state, serverSettled: generation, completed: null }
}

export function cancelTurnAfterTransportFailure(
  state: TurnGenerationState,
  generation: number,
): TurnGenerationState {
  if (
    generation !== state.current
    || state.serverSettled !== generation
    || (
      state.stopping !== generation
      && state.completionAcknowledged !== generation
    )
  ) return state

  return {
    ...state,
    stopping: null,
    abortAcknowledged: generation,
    completionAcknowledged: null,
    cancelled: generation,
    completed: null,
  }
}

export function completeTurn(state: TurnGenerationState, generation: number): TurnGenerationState {
  if (generation !== state.current || state.cancelled === generation) return state
  if (state.stopping === generation) {
    if (state.abortAcknowledged === generation) return state
    return state.serverSettled === generation
      ? { ...state, stopping: null, completionAcknowledged: generation, completed: generation }
      : { ...state, completionAcknowledged: generation }
  }
  return { ...state, stopping: null, cancelled: null, completed: generation }
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
