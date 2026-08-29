type ModelPricing = {
  inputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
  outputPerM: number
}

// Prices in USD per 1M tokens — DeepSeek V4 via Vercel AI Gateway (https://ai-gateway.vercel.sh/v1/models)
// cacheWritePerM is not published by Vercel for these models — using input rate as conservative fallback
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek/deepseek-v4-flash": {
    inputPerM: 0.13,
    cacheReadPerM: 0.028,
    cacheWritePerM: 0.13,
    outputPerM: 0.26,
  },
}

const FALLBACK_PRICING: ModelPricing = {
  inputPerM: 0,
  cacheReadPerM: 0,
  cacheWritePerM: 0,
  outputPerM: 0,
}

export function computeCostUsd(
  modelId: string,
  tokens: {
    noCacheTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  },
): number {
  const p = MODEL_PRICING[modelId] ?? FALLBACK_PRICING
  return (
    (tokens.noCacheTokens * p.inputPerM +
      tokens.cacheReadTokens * p.cacheReadPerM +
      tokens.cacheWriteTokens * p.cacheWritePerM +
      tokens.outputTokens * p.outputPerM) /
    1_000_000
  )
}
