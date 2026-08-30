import { count } from "drizzle-orm"
import handler from "@tanstack/react-start/server-entry"
import { Webhook } from "svix"
export { ChatAgent } from "@/agent/runtime/chat-agent.server"
export { AnalysisSandbox } from "@/agent/runtime/analysis-sandbox.server"
import { handleSandboxApi } from "@/agent/sandbox/api.server"
import { routeAuthenticatedAgentRequest } from "@/server/agent-routing.server"
import { getDb } from "@/db/index.server"
import { trade } from "@/db/schema"
import { upsertUser, deleteUser } from "@/user/api.server"
import {
  getCompanyProfile,
  getFXRate,
  getFundamentals,
  getNews,
  getNextEarnings,
  getQuote,
} from "@/market/api.server"
import type { Currency } from "@/market"

function jsonError(e: unknown, status = 500) {
  return Response.json(
    { ok: false, error: e instanceof Error ? e.message : String(e) },
    { status },
  )
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === "/api/health") {
      try {
        const [row] = await getDb().select({ value: count() }).from(trade)
        return Response.json({ ok: true, tradeCount: row.value })
      } catch (e) {
        return jsonError(e)
      }
    }

    if (url.pathname.startsWith("/api/sandbox/")) {
      return handleSandboxApi(request, env)
    }

    // DEV smoke endpoints — remove once chat/portfolio consume the market layer directly.
    let m
    if ((m = url.pathname.match(/^\/api\/dev\/quote\/([A-Za-z0-9.-]+)$/))) {
      try {
        return Response.json({ ok: true, quote: await getQuote(m[1]) })
      } catch (e) {
        return jsonError(e)
      }
    }
    if ((m = url.pathname.match(/^\/api\/dev\/fx\/([A-Za-z]{3})\/([A-Za-z]{3})$/))) {
      try {
        const rate = await getFXRate(
          m[1].toUpperCase() as Currency,
          m[2].toUpperCase() as Currency,
        )
        return Response.json({ ok: true, rate })
      } catch (e) {
        return jsonError(e)
      }
    }
    if ((m = url.pathname.match(/^\/api\/dev\/news\/([A-Za-z0-9.-]+)$/))) {
      try {
        const days = Number(url.searchParams.get("days") ?? 7)
        return Response.json({ ok: true, news: await getNews(m[1], { days }) })
      } catch (e) {
        return jsonError(e)
      }
    }
    if ((m = url.pathname.match(/^\/api\/dev\/earnings\/([A-Za-z0-9.-]+)$/))) {
      try {
        return Response.json({ ok: true, next: await getNextEarnings(m[1]) })
      } catch (e) {
        return jsonError(e)
      }
    }
    if ((m = url.pathname.match(/^\/api\/dev\/company\/([A-Za-z0-9.-]+)$/))) {
      try {
        return Response.json({ ok: true, profile: await getCompanyProfile(m[1]) })
      } catch (e) {
        return jsonError(e)
      }
    }
    if ((m = url.pathname.match(/^\/api\/dev\/fundamentals\/([A-Za-z0-9.-]+)$/))) {
      try {
        return Response.json({ ok: true, fundamentals: await getFundamentals(m[1]) })
      } catch (e) {
        return jsonError(e)
      }
    }

    if (url.pathname === "/api/webhooks/clerk" && request.method === "POST") {
      try {
        const secret = (env as Env & { CLERK_WEBHOOK_SECRET: string }).CLERK_WEBHOOK_SECRET
        const wh = new Webhook(secret)
        const body = await request.text()
        const evt = wh.verify(body, {
          "svix-id": request.headers.get("svix-id") ?? "",
          "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
          "svix-signature": request.headers.get("svix-signature") ?? "",
        }) as { type: string; data: Record<string, unknown> }

        if (evt.type === "user.created" || evt.type === "user.updated") {
          const d = evt.data
          const emails = (d.email_addresses as Array<{ email_address: string; id: string }>) ?? []
          const primaryId = d.primary_email_address_id as string
          const email = emails.find((e) => e.id === primaryId)?.email_address ?? emails[0]?.email_address ?? ""
          const displayName =
            [d.first_name, d.last_name].filter(Boolean).join(" ") ||
            (d.username as string) ||
            email
          await upsertUser({ id: d.id as string, email, displayName })
        } else if (evt.type === "user.deleted") {
          await deleteUser(evt.data.id as string)
        }

        return Response.json({ ok: true })
      } catch (e) {
        return jsonError(e, 400)
      }
    }

    const agentRes = await routeAuthenticatedAgentRequest(request, env as Env)
    if (agentRes) return agentRes

    return handler.fetch(request)
  },
} satisfies ExportedHandler<Env>
