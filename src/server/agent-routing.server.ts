import { routeAgentRequest } from "agents"
import { authorizeChatAgentRequest } from "@/agent/runtime/chat-agent-auth.server"

export function routeAuthenticatedAgentRequest(request: Request, env: Env) {
  return routeAgentRequest(request, env, {
    onBeforeConnect: async (upgradeRequest, route) => {
      if (route.className !== "CHAT") return
      return authorizeChatAgentRequest(upgradeRequest, route.name, env.CLERK_SECRET_KEY)
    },
  })
}
