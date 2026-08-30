import {
  DEFAULT_GENERAL_CHAT_MODEL,
  type GeneralChatModelKey,
  type ProviderOptions,
} from "@/agent/general-chat-models"

type SelectionBase = {
  version: number
  modelKey: GeneralChatModelKey
  providerOptions: ProviderOptions
}

export type DraftChatSelection = SelectionBase & {
  kind: "draft"
  creatingIntent: number | null
}

export type PersistedChatSelection = SelectionBase & {
  kind: "thread"
  threadId: string
  title: string | null
  initialMessage: string | null
}

export type ChatSelection = DraftChatSelection | PersistedChatSelection

export function chatSessionKey(selection: PersistedChatSelection): string {
  return `${selection.threadId}:${selection.version}`
}

export function initialChatSelection(): DraftChatSelection {
  return {
    kind: "draft",
    version: 0,
    modelKey: DEFAULT_GENERAL_CHAT_MODEL,
    providerOptions: {},
    creatingIntent: null,
  }
}

export function selectNewDraft(current: ChatSelection): DraftChatSelection {
  return {
    kind: "draft",
    version: current.version + 1,
    modelKey: DEFAULT_GENERAL_CHAT_MODEL,
    providerOptions: {},
    creatingIntent: null,
  }
}

export function selectPersistedThread(
  current: ChatSelection,
  thread: {
    id: string
    title: string | null
    modelKey: GeneralChatModelKey
    providerOptions?: ProviderOptions
  },
  initialMessage: string | null = null
): PersistedChatSelection {
  return {
    kind: "thread",
    version: current.version + 1,
    threadId: thread.id,
    title: thread.title,
    modelKey: thread.modelKey,
    providerOptions: thread.providerOptions ?? {},
    initialMessage,
  }
}

export function beginDraftCreation(
  current: ChatSelection,
  intent: number
): ChatSelection {
  if (current.kind !== "draft") return current
  return { ...current, creatingIntent: intent }
}

export function settleDraftCreation(
  current: ChatSelection,
  intent: number
): ChatSelection {
  if (current.kind !== "draft" || current.creatingIntent !== intent)
    return current
  return { ...current, creatingIntent: null }
}

export function updateSelectionModel(
  current: ChatSelection,
  modelKey: GeneralChatModelKey,
  providerOptions: ProviderOptions
): ChatSelection {
  return { ...current, modelKey, providerOptions }
}

export function updateSelectionThinking(
  current: ChatSelection,
  providerOptions: ProviderOptions
): ChatSelection {
  return { ...current, providerOptions }
}

export function markInitialMessageDispatched(
  current: ChatSelection,
  version: number,
  threadId: string
): ChatSelection {
  if (
    current.kind !== "thread" ||
    current.version !== version ||
    current.threadId !== threadId
  )
    return current
  return { ...current, initialMessage: null }
}

export function updateSelectionTitle(
  current: ChatSelection,
  version: number,
  threadId: string,
  title: string
): ChatSelection {
  if (
    current.kind !== "thread" ||
    current.version !== version ||
    current.threadId !== threadId
  )
    return current
  return { ...current, title }
}
