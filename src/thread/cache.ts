import type { InfiniteData } from "@tanstack/react-query"
import type { Thread } from "@/thread/types"

export type ThreadPage = {
  threads: Thread[]
  nextCursor: string | null
}

export function prependThreadToInfiniteData(
  data: InfiniteData<ThreadPage, string | undefined> | undefined,
  thread: Thread,
): InfiniteData<ThreadPage, string | undefined> {
  if (!data || data.pages.length === 0) {
    return {
      pages: [{ threads: [thread], nextCursor: null }],
      pageParams: [undefined],
    }
  }

  const pages = data.pages.map((page) => ({
    ...page,
    threads: page.threads.filter((existing) => existing.id !== thread.id),
  }))
  pages[0] = { ...pages[0], threads: [thread, ...pages[0].threads] }
  return { ...data, pages }
}
