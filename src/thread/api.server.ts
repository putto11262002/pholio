import { and, desc, eq, lt } from "drizzle-orm"
import { getDb } from "@/db/index.server"
import { thread } from "@/db/schema"
import type { NewThread } from "./types"

export async function createThread(data: Omit<NewThread, "id" | "createdAt" | "updatedAt">) {
  const db = getDb()
  const id = crypto.randomUUID()
  const [created] = await db.insert(thread).values({ ...data, id }).returning()
  return created
}

export async function listThreads(userId: string, opts?: { cursor?: string; limit?: number }) {
  const limit = opts?.limit ?? 20
  const db = getDb()

  const rows = await db
    .select()
    .from(thread)
    .where(
      opts?.cursor
        ? and(eq(thread.userId, userId), lt(thread.updatedAt, new Date(opts.cursor)))
        : eq(thread.userId, userId),
    )
    .orderBy(desc(thread.updatedAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  return {
    threads: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? rows[limit - 1].updatedAt.toISOString() : null,
  }
}

export async function getThread(id: string, userId: string) {
  const db = getDb()
  const [row] = await db.select().from(thread).where(and(eq(thread.id, id), eq(thread.userId, userId)))
  return row ?? null
}

export async function getThreadOwnerUserId(id: string): Promise<string | null> {
  const db = getDb()
  const [row] = await db.select({ userId: thread.userId }).from(thread).where(eq(thread.id, id))
  return row?.userId ?? null
}

export async function updateThread(id: string, data: Partial<Pick<NewThread, "title" | "modelKey" | "providerOptions">>, userId: string) {
  const db = getDb()
  await db
    .update(thread)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(thread.id, id), eq(thread.userId, userId)))
}

export async function deleteThread(id: string, userId: string) {
  const db = getDb()
  await db.delete(thread).where(and(eq(thread.id, id), eq(thread.userId, userId)))
}

export async function touchThread(id: string, userId: string) {
  const db = getDb()
  await db.update(thread).set({ updatedAt: new Date() }).where(and(eq(thread.id, id), eq(thread.userId, userId)))
}
