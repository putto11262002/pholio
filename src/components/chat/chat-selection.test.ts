import { describe, expect, it } from "vitest"
import {
  beginDraftCreation,
  chatSessionKey,
  initialChatSelection,
  markInitialMessageObserved,
  selectNewDraft,
  selectPersistedThread,
  settleDraftCreation,
  updateSelectionTitle,
} from "./chat-selection"

describe("chat selection", () => {
  it("atomically replaces a persisted conversation with a versioned empty draft", () => {
    const oldThread = selectPersistedThread(initialChatSelection(), {
      id: "old-thread",
      title: "Old context",
      modelKey: "flash",
    })

    const draft = selectNewDraft(oldThread)

    expect(draft).toEqual({
      kind: "draft",
      version: oldThread.version + 1,
      modelKey: "flash",
      providerOptions: {},
      creatingIntent: null,
    })
    expect("threadId" in draft).toBe(false)
    expect("initialMessage" in draft).toBe(false)
  })

  it("changes the mounted chat session across new and repeated thread selection", () => {
    const firstMount = selectPersistedThread(initialChatSelection(), {
      id: "same-thread",
      title: null,
      modelKey: "flash",
    })
    const secondMount = selectPersistedThread(selectNewDraft(firstMount), {
      id: "same-thread",
      title: null,
      modelKey: "flash",
    })

    expect(chatSessionKey(secondMount)).not.toBe(chatSessionKey(firstMount))
  })

  it("isolates a new first message from every field in the old conversation", () => {
    const oldThread = selectPersistedThread(
      initialChatSelection(),
      {
        id: "old-thread",
        title: "Use conservative risk tolerance",
        modelKey: "flash",
      },
      { id: "old-message", text: "old transcript prompt" }
    )
    const draft = selectNewDraft(oldThread)
    const newThread = selectPersistedThread(
      draft,
      {
        id: "new-thread",
        title: null,
        modelKey: "flash",
      },
      { id: "fresh-message", text: "fresh prompt" }
    )

    expect(newThread.threadId).toBe("new-thread")
    expect(newThread.title).toBeNull()
    expect(newThread.initialMessage).toEqual({ id: "fresh-message", text: "fresh prompt" })
    expect(newThread.version).toBeGreaterThan(oldThread.version)
    expect(JSON.stringify(newThread)).not.toContain("old transcript prompt")
    expect(JSON.stringify(newThread)).not.toContain("conservative")
  })

  it("ignores late callbacks from an unmounted conversation", () => {
    const oldThread = selectPersistedThread(
      initialChatSelection(),
      {
        id: "old-thread",
        title: null,
        modelKey: "flash",
      },
      { id: "old-message", text: "old prompt" }
    )
    const newThread = selectPersistedThread(
      selectNewDraft(oldThread),
      {
        id: "new-thread",
        title: null,
        modelKey: "flash",
      },
      { id: "new-message", text: "new prompt" }
    )

    expect(
      markInitialMessageObserved(
        newThread,
        oldThread.version,
        oldThread.threadId
      )
    ).toEqual(newThread)
    expect(
      updateSelectionTitle(
        newThread,
        oldThread.version,
        oldThread.threadId,
        "stale title"
      )
    ).toEqual(newThread)
  })

  it("does not let a settled older create unlock a newer draft create", () => {
    const firstCreate = beginDraftCreation(initialChatSelection(), 1)
    const newerDraft = beginDraftCreation(selectNewDraft(firstCreate), 3)

    expect(settleDraftCreation(newerDraft, 1)).toEqual(newerDraft)
    expect(settleDraftCreation(newerDraft, 3)).toEqual({
      ...newerDraft,
      creatingIntent: null,
    })
  })

  it("keeps one coherent selection through rapid create, switch, and new actions", () => {
    const creating = beginDraftCreation(initialChatSelection(), 1)
    const switched = selectPersistedThread(creating, {
      id: "existing-thread",
      title: "Existing",
      modelKey: "flash",
    })
    const newCreate = beginDraftCreation(selectNewDraft(switched), 4)

    expect(newCreate).toMatchObject({
      kind: "draft",
      version: 2,
      creatingIntent: 4,
    })
    expect("threadId" in newCreate).toBe(false)
    expect(settleDraftCreation(newCreate, 1)).toEqual(newCreate)
  })
})
