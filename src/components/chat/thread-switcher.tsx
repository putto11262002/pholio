import { useRef, useEffect } from "react"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { MessagesSquare, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { listThreadsFn, deleteThreadFn } from "@/thread/functions"
import type { Thread } from "@/thread/types"
import { discardPendingInitialMessage } from "@/components/chat/chat-initial-message"

type SidebarProps = {
  open: boolean
  onClose: () => void
  userId: string
  activeThreadId: string | null
  onSelect: (thread: Thread) => void
  onNew: () => void
}

export function ConversationSidebar({ open, onClose, userId, activeThreadId, onSelect, onNew }: SidebarProps) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ["threads", userId],
    queryFn: ({ pageParam }) =>
      listThreadsFn({ data: { cursor: pageParam as string | undefined, limit: 20 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open,
  })

  const threads = data?.pages.flatMap((p) => p.threads) ?? []

  const deleteMutation = useMutation({
    mutationFn: (threadId: string) => deleteThreadFn({ data: { id: threadId } }),
    onSuccess: (_data, threadId) => {
      discardPendingInitialMessage(localStorage, threadId)
      qc.invalidateQueries({ queryKey: ["threads", userId] })
      if (threadId === activeThreadId) {
        const remaining = threads.filter((t) => t.id !== threadId)
        if (remaining.length > 0) {
          onSelect(remaining[0])
        } else {
          onNew()
        }
      }
      onClose()
      toast.success("Conversation deleted")
    },
    onError: () => {
      toast.error("Couldn't delete conversation")
    },
  })

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage()
      },
      { threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <>
      {/* Sidebar panel */}
      <div
        onMouseLeave={onClose}
        className={cn(
          "absolute inset-y-4 left-4 z-30 flex w-72 flex-col bg-background/60 backdrop-blur-xl border border-white/10 shadow-2xl rounded-4xl overflow-hidden",
          "transition-all duration-200 ease-out",
          open ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 -translate-x-2 pointer-events-none",
        )}
      >
        <div className="px-4 pt-4 pb-2">
          <span className="text-xs font-medium text-foreground">Conversations</span>
        </div>

        <div className="px-3 pb-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { onNew(); onClose() }}
            className="w-full gap-2 rounded-2xl text-xs"
          >
            <Plus className="size-3.5" />
            New conversation
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {isLoading && (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full rounded-2xl" />
              ))}
            </div>
          )}
          {!isLoading && threads.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>
          )}
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { onSelect(t); onClose() }}
              className={cn(
                "group/item flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-xs transition-colors hover:bg-white/10",
                t.id === activeThreadId ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="truncate">{t.title ?? "New conversation"}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(t.id) }}
                disabled={deleteMutation.isPending}
                className="ml-1 shrink-0 opacity-0 group-hover/item:opacity-100 rounded-md p-0.5 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="size-3" />
              </button>
            </button>
          ))}
          {isFetchingNextPage && (
            <Skeleton className="mt-1 h-7 w-full rounded-2xl" />
          )}
          <div ref={sentinelRef} className="h-px" />
        </div>
      </div>
    </>
  )
}

export function ConversationToggle({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={onClick}
      className="size-7 rounded-full bg-background/80 backdrop-blur-sm shadow text-muted-foreground hover:text-foreground"
      aria-label="Conversations"
    >
      <MessagesSquare className="size-3.5" />
    </Button>
  )
}
