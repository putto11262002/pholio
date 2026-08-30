export type PendingInitialMessage = {
  id: string
  text: string
}

const PENDING_INITIAL_MESSAGE_PREFIX = "pendingChatInitialMessage:"

function storageKey(threadId: string): string {
  return `${PENDING_INITIAL_MESSAGE_PREFIX}${threadId}`
}

export function readPendingInitialMessage(
  storage: Pick<Storage, "getItem">,
  threadId: string,
): PendingInitialMessage | null {
  const value = storage.getItem(storageKey(threadId))
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<PendingInitialMessage>
    if (typeof parsed.id !== "string" || !parsed.id) return null
    if (typeof parsed.text !== "string" || !parsed.text) return null
    return { id: parsed.id, text: parsed.text }
  } catch {
    return null
  }
}

export function writePendingInitialMessage(
  storage: Pick<Storage, "setItem">,
  threadId: string,
  message: PendingInitialMessage,
): void {
  storage.setItem(storageKey(threadId), JSON.stringify(message))
}

export function clearPendingInitialMessage(
  storage: Pick<Storage, "getItem" | "removeItem">,
  threadId: string,
  messageId: string,
): boolean {
  const pending = readPendingInitialMessage(storage, threadId)
  if (pending?.id !== messageId) return false
  storage.removeItem(storageKey(threadId))
  return true
}

export function discardPendingInitialMessage(
  storage: Pick<Storage, "removeItem">,
  threadId: string,
): void {
  storage.removeItem(storageKey(threadId))
}
