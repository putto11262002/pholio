import { createGateway, type GatewayModelId } from "ai"
import { env } from "cloudflare:workers"

export function createModel(modelId: GatewayModelId) {
  const gateway = createGateway({
    apiKey: env.VERCEL_AI_GATEWAY_KEY,
  })
  return gateway(modelId)
}
