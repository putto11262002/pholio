export const CHAT_SETTLEMENT_TIMEOUT_MS = 10_000

export type ChatSettlementResult = {
  status: "stable" | "timeout" | "unavailable"
}
