import { verifyToken } from "@clerk/backend"
import { getThreadOwnerUserId } from "@/thread/api.server"

export async function authorizeChatAgentRequest(
  request: Request,
  threadId: string,
  secretKey: string,
): Promise<Response | undefined> {
  const sessionToken = request.headers.get("cookie")?.match(/(?:^|;\s*)__session=([^;]+)/)?.[1]
  if (!sessionToken) return new Response("Unauthorized", { status: 401 })

  let userId: string
  try {
    const payload = await verifyToken(sessionToken, { secretKey })
    userId = payload.sub
  } catch {
    return new Response("Unauthorized", { status: 401 })
  }

  const threadUserId = await getThreadOwnerUserId(threadId)
  if (!threadUserId) return new Response("Not Found", { status: 404 })
  if (threadUserId !== userId) return new Response("Forbidden", { status: 403 })
}
