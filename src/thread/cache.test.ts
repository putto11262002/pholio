import { describe, expect, it } from "vitest"
import { prependThreadToInfiniteData } from "./cache"
import type { Thread } from "./types"

function thread(id: string, title: string): Thread {
  return {
    id,
    userId: "user-1",
    title,
    modelKey: "flash",
    providerOptions: {},
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  }
}

describe("prependThreadToInfiniteData", () => {
  it("seeds membership when history has never been opened", () => {
    const created = thread("new", "New")

    expect(prependThreadToInfiniteData(undefined, created)).toEqual({
      pages: [{ threads: [created], nextCursor: null }],
      pageParams: [undefined],
    })
  })

  it("prepends the actual row, dedupes every page, and preserves cursors", () => {
    const oldCreated = thread("new", "Stale")
    const actualCreated = { ...oldCreated, title: "Actual" }
    const data = {
      pages: [
        { threads: [thread("one", "One")], nextCursor: "cursor-1" },
        { threads: [oldCreated, thread("two", "Two")], nextCursor: null },
      ],
      pageParams: [undefined, "cursor-1"],
    }

    const result = prependThreadToInfiniteData(data, actualCreated)

    expect(result.pages[0]).toEqual({
      threads: [actualCreated, thread("one", "One")],
      nextCursor: "cursor-1",
    })
    expect(result.pages[1]).toEqual({
      threads: [thread("two", "Two")],
      nextCursor: null,
    })
    expect(result.pageParams).toEqual(data.pageParams)
  })
})
