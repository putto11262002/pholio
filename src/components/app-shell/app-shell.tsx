import { Suspense, useState, useRef, useCallback, type CSSProperties, type ReactNode } from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { getCurrentUserFn } from "@/auth"
import { QueryErrorBoundary } from "@/components/query-error-boundary"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatPanel } from "@/components/chat/chat-panel"
import { AppSidebar } from "./app-sidebar"
import { UserMenu } from "./user-menu"
import { AuthError } from "./auth-error"
import { AuthSplash } from "./auth-splash"
import { ChevronDown, LayoutDashboard, PieChart, TrendingUp, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Link } from "@tanstack/react-router"

const MIN_CHAT_WIDTH = 320
const MAX_CHAT_WIDTH = 640
const DEFAULT_CHAT_WIDTH = 500

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <QueryErrorBoundary fallback={AuthError}>
      <Suspense fallback={<AuthSplash />}>
        <AppShellInner>{children}</AppShellInner>
      </Suspense>
    </QueryErrorBoundary>
  )
}

function AppShellInner({ children }: { children: ReactNode }) {
  const [mobileView, setMobileView] = useState<"app" | "chat">("app")
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useSuspenseQuery({
    queryKey: ["currentUser"],
    queryFn: () => getCurrentUserFn(),
    staleTime: Infinity,
  })

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!isResizing.current) return
    const delta = startX.current - e.clientX
    setChatWidth(Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth.current + delta)))
  }, [])

  const onPointerUp = useCallback(() => {
    isResizing.current = false
    setIsDragging(false)
    document.removeEventListener("pointermove", onPointerMove)
    document.removeEventListener("pointerup", onPointerUp)
  }, [onPointerMove])

  function startResize(e: React.PointerEvent) {
    isResizing.current = true
    setIsDragging(true)
    startX.current = e.clientX
    startWidth.current = chatWidth
    document.addEventListener("pointermove", onPointerMove)
    document.addEventListener("pointerup", onPointerUp)
    e.preventDefault()
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-svh overflow-hidden">
        {/* Floating pill */}
        <div className="absolute top-4 left-0 right-0 z-50 flex justify-center pointer-events-none lg:hidden">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-background/80 backdrop-blur-sm shadow-lg p-1">
            {/* App dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={() => setMobileView("app")}
                  className={cn(
                    "flex items-center gap-1 rounded-full px-4 py-1 text-sm font-medium transition-colors",
                    mobileView === "app"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  App <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem asChild>
                  <Link to="/" onClick={() => setMobileView("app")} className="flex items-center gap-2">
                    <LayoutDashboard className="size-4" /> Dashboard
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/positions" onClick={() => setMobileView("app")} className="flex items-center gap-2">
                    <PieChart className="size-4" /> Positions
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/trades" onClick={() => setMobileView("app")} className="flex items-center gap-2">
                    <TrendingUp className="size-4" /> Trades
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/usage" onClick={() => setMobileView("app")} className="flex items-center gap-2">
                    <Zap className="size-4" /> Usage
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <div className="w-full"><UserMenu /></div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Chat toggle */}
            <button
              onClick={() => setMobileView("chat")}
              className={cn(
                "rounded-full px-4 py-1 text-sm font-medium transition-colors",
                mobileView === "chat"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Chat
            </button>
          </div>
        </div>

        {/* App and chat stay mounted while the mobile toggle changes visibility. */}
        <div className={cn("h-full min-w-0 overflow-hidden lg:flex lg:flex-1", mobileView === "app" ? "flex w-full" : "hidden")}>
          <div className="hidden lg:block"><AppSidebar /></div>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <main className="flex-1 overflow-y-auto pt-16 lg:pt-0">{children}</main>
          </div>
        </div>

        <div
          style={{ "--chat-width": `${chatWidth}px` } as CSSProperties}
          className={cn(
            "h-full w-full shrink-0 overflow-hidden pt-16 lg:my-2 lg:mr-2 lg:h-auto lg:w-[var(--chat-width)] lg:rounded-4xl lg:border-2 lg:pt-0 lg:shadow-lg lg:transition-colors",
            mobileView === "chat" ? "flex" : "hidden lg:flex",
            isDragging ? "lg:border-primary" : "lg:border-primary/70",
          )}
        >
          <div
            onPointerDown={startResize}
            className="hidden w-1 shrink-0 cursor-col-resize rounded-l-4xl lg:block"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <ChatPanel />
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
