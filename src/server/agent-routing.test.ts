import { beforeEach, describe, expect, it, vi } from "vitest"
import { routeAuthenticatedAgentRequest } from "./agent-routing.server"

const mocks = vi.hoisted(() => ({
  getThreadOwnerUserId: vi.fn(),
  verifyToken: vi.fn(),
}))

vi.mock("agents", async () => {
  const routing = await import("../../node_modules/agents/dist/agent-routing.js")
  return { routeAgentRequest: routing.routeAgentRequest }
})
vi.mock("@clerk/backend", () => ({ verifyToken: mocks.verifyToken }))
vi.mock("@/thread/api.server", () => ({
  getThreadOwnerUserId: mocks.getThreadOwnerUserId,
}))

function websocketRequest(cookie?: string) {
  const headers = new Headers({ Upgrade: "websocket" })
  if (cookie) headers.set("Cookie", cookie)
  return new Request("https://pholio.test/agents/chat/thread-1", { headers })
}

function createEnv() {
  const fetch = vi.fn((_request: Request) => Promise.resolve(new Response("upgraded")))
  const get = vi.fn(() => ({ fetch }))
  const idFromName = vi.fn((name: string) => name)
  const env = {
    CHAT: { get, idFromName },
    CLERK_SECRET_KEY: "clerk-secret",
  } as unknown as Env
  return { env, fetch, get, idFromName }
}

describe("authenticated Agent websocket routing", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects a websocket upgrade without a Clerk session before forwarding", async () => {
    const { env, fetch } = createEnv()

    const response = await routeAuthenticatedAgentRequest(websocketRequest(), env)

    expect(response?.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the routed Agent name to reject a websocket owned by another user", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user-1" })
    mocks.getThreadOwnerUserId.mockResolvedValue("user-2")
    const { env, fetch } = createEnv()

    const response = await routeAuthenticatedAgentRequest(
      websocketRequest("__session=valid-token"),
      env,
    )

    expect(mocks.verifyToken).toHaveBeenCalledWith("valid-token", {
      secretKey: "clerk-secret",
    })
    expect(mocks.getThreadOwnerUserId).toHaveBeenCalledWith("thread-1")
    expect(response?.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("forwards an owned websocket upgrade to the ChatAgent namespace", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user-1" })
    mocks.getThreadOwnerUserId.mockResolvedValue("user-1")
    const { env, fetch, get, idFromName } = createEnv()
    const request = websocketRequest("other=value; __session=valid-token")

    const response = await routeAuthenticatedAgentRequest(request, env)

    expect(response?.status).toBe(200)
    expect(idFromName).toHaveBeenCalledWith("thread-1")
    expect(get).toHaveBeenCalledWith("thread-1", undefined)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0].headers.get("Upgrade")).toBe("websocket")
  })
})
