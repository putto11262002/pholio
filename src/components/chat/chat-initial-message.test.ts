import { describe, expect, it } from "vitest"
import {
  clearPendingInitialMessage,
  discardPendingInitialMessage,
  readPendingInitialMessage,
  writePendingInitialMessage,
} from "./chat-initial-message"

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe("pending initial chat message", () => {
  it("round-trips a stable id and text by thread", () => {
    const storage = new MemoryStorage()
    const message = { id: "message-1", text: "fresh prompt" }

    writePendingInitialMessage(storage, "thread-1", message)

    expect(readPendingInitialMessage(storage, "thread-1")).toEqual(message)
    expect(readPendingInitialMessage(storage, "thread-2")).toBeNull()
  })

  it("only clears the exact pending message id", () => {
    const storage = new MemoryStorage()
    writePendingInitialMessage(storage, "thread-1", { id: "message-1", text: "fresh prompt" })

    expect(clearPendingInitialMessage(storage, "thread-1", "other-message")).toBe(false)
    expect(readPendingInitialMessage(storage, "thread-1")).not.toBeNull()
    expect(clearPendingInitialMessage(storage, "thread-1", "message-1")).toBe(true)
    expect(readPendingInitialMessage(storage, "thread-1")).toBeNull()
  })

  it("discards a pending handoff after its thread is deleted", () => {
    const storage = new MemoryStorage()
    writePendingInitialMessage(storage, "thread-1", { id: "message-1", text: "fresh prompt" })

    discardPendingInitialMessage(storage, "thread-1")

    expect(readPendingInitialMessage(storage, "thread-1")).toBeNull()
  })
})
