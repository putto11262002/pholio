export type ChatFailurePhase =
  | "thread_lookup"
  | "usage_preflight"
  | "model_resolution"
  | "history_conversion"
  | "skills_load"
  | "tool_setup"
  | "provider_start"
  | "provider_stream"
  | "tool_continuation"
  | "ui_stream"

type FailureLog = {
  event: "agent.chat.terminal_failure"
  referenceId: string
  phase: ChatFailurePhase
  durationMs: number
  firstOutputArrived: boolean
  status: number | null
  code: string
  retryable: boolean
  modelId?: string
}

type ChatTurnDiagnosticsOptions = {
  referenceId?: string
  now?: () => number
  log?: (entry: FailureLog) => void
}

const KNOWN_ERROR_CODES = new Map([
  ["AbortError", "aborted"],
  ["TimeoutError", "timeout"],
  ["AI_APICallError", "provider_api_error"],
  ["AI_RetryError", "provider_retry_exhausted"],
  ["AI_MessageConversionError", "history_conversion"],
  ["GatewayAuthenticationError", "gateway_authentication"],
  ["GatewayFailedDependencyError", "gateway_failed_dependency"],
  ["GatewayForbiddenError", "gateway_forbidden"],
  ["GatewayInternalServerError", "gateway_internal"],
  ["GatewayInvalidRequestError", "gateway_invalid_request"],
  ["GatewayModelNotFoundError", "gateway_model_not_found"],
  ["GatewayNotFoundError", "gateway_not_found"],
  ["GatewayRateLimitError", "gateway_rate_limit"],
  ["GatewayResponseError", "gateway_response"],
  ["GatewayTimeoutError", "gateway_timeout"],
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function safeGet(value: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function safeNow(now: () => number): number {
  try {
    const value = now()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function createReferenceId(): string {
  return `CHAT-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`
}

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9._:/-]+$/u.test(value)
    ? value
    : undefined
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = []
  const seen = new WeakSet<object>()
  let current: unknown = error
  while (isRecord(current) && chain.length < 6 && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    const lastError = safeGet(current, "lastError")
    current = isRecord(lastError) ? lastError : safeGet(current, "cause")
  }
  return chain
}

function failureMetadata(error: unknown): Pick<FailureLog, "status" | "code" | "retryable"> {
  const chain = errorChain(error)
  let status: number | null = null
  let code = "unknown"
  let retryable: boolean | undefined

  for (const item of chain) {
    const statusCode = safeGet(item, "statusCode")
    const fallbackStatus = safeGet(item, "status")
    const candidateStatus = typeof statusCode === "number"
      ? statusCode
      : typeof fallbackStatus === "number"
        ? fallbackStatus
        : null
    if (status === null && candidateStatus !== null && Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599) {
      status = candidateStatus
    }

    const rawName = safeGet(item, "name")
    const name = typeof rawName === "string" ? rawName : ""
    const knownCode = KNOWN_ERROR_CODES.get(name)
    if (code === "unknown" && knownCode) code = knownCode
    const isRetryable = safeGet(item, "isRetryable")
    const fallbackRetryable = safeGet(item, "retryable")
    if (retryable === undefined && typeof isRetryable === "boolean") retryable = isRetryable
    if (retryable === undefined && typeof fallbackRetryable === "boolean") retryable = fallbackRetryable
  }

  if (code === "unknown" && status !== null) code = `http_${status}`
  if (retryable === undefined) {
    retryable = status === 408 || status === 429 || (status !== null && status >= 500) || code === "timeout"
  }
  return { status, code, retryable }
}

export class ChatTurnDiagnostics {
  readonly referenceId: string
  private readonly startedAt: number
  private readonly now: () => number
  private readonly log: (entry: FailureLog) => void
  private phase: ChatFailurePhase = "usage_preflight"
  private modelId?: string
  private firstOutputArrived = false
  private terminalFailureRecorded = false

  constructor(options: ChatTurnDiagnosticsOptions = {}) {
    this.referenceId = safeIdentifier(options.referenceId, 64) ?? createReferenceId()
    this.now = options.now ?? Date.now
    this.startedAt = safeNow(this.now)
    this.log = options.log ?? ((entry) => console.error(JSON.stringify(entry)))
  }

  markPhase(phase: ChatFailurePhase): void {
    if (!this.terminalFailureRecorded) this.phase = phase
  }

  setModelId(modelId: string): void {
    const safeModelId = safeIdentifier(modelId, 160)
    if (safeModelId) this.modelId = safeModelId
  }

  markFirstOutput(): void {
    this.firstOutputArrived = true
  }

  recordFailure(error: unknown, phase: ChatFailurePhase = this.phase): boolean {
    if (this.terminalFailureRecorded) return false
    this.terminalFailureRecorded = true
    const metadata = failureMetadata(error)
    const entry: FailureLog = {
      event: "agent.chat.terminal_failure",
      referenceId: this.referenceId,
      phase,
      durationMs: Math.max(0, safeNow(this.now) - this.startedAt),
      firstOutputArrived: this.firstOutputArrived,
      status: metadata.status,
      code: metadata.code,
      retryable: metadata.retryable,
      ...(this.modelId ? { modelId: this.modelId } : {}),
    }
    try {
      this.log(entry)
    } catch {
      // Diagnostics must never replace the original chat failure.
    }
    return true
  }

  userError(message: string): string {
    return `${message} Reference: ${this.referenceId}.`
  }
}

export function createChatTurnDiagnostics(): ChatTurnDiagnostics {
  return new ChatTurnDiagnostics()
}
