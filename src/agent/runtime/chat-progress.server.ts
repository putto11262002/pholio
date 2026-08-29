import type { InferUIMessageChunk } from "ai"
import type {
  ChatMessage,
  ChatProgressEvent,
  ChatProgressPhase,
  ChatProgressStatus,
} from "@/agent/chat-message"
import { toolDisplayRegistry, toolLabel, toolLoadingMessage, toolResultMessage } from "@/agent/tool-display"

type ProgressChunk = InferUIMessageChunk<ChatMessage>

export function createChatProgressRunId(requestId?: string, uniqueSuffix: string = crypto.randomUUID()): string {
  return `${requestId || "chat-run"}:${uniqueSuffix}`
}

export type ChatProgressUpdate = {
  activityId: string
  phase: ChatProgressPhase
  status?: ChatProgressStatus
  label: string
  message: string
  toolName?: string
  toolCallId?: string
}

export type ChatProgressCallbacks = {
  waiting: (stepNumber: number) => void
  composing: (stepNumber: number) => void
  recovering: (message?: string) => void
  toolStarted: (toolName: string, toolCallId: string, input: unknown) => void
  toolFinished: (toolName: string, toolCallId: string, success: boolean, output?: unknown) => void
  analysisPhase: (toolCallId: string, phase: "provisioning" | "uploading" | "running" | "reading") => void
  completed: () => void
  cancelled: () => void
  failed: (message?: string) => void
}

export function createChatProgressEmitter({
  runId,
  write,
}: {
  runId: string
  write: (chunk: ProgressChunk) => void
}) {
  let ordinal = 0
  let terminal = false
  const toolNames = new Map<string, string>()

  function emit(update: ChatProgressUpdate): ChatProgressEvent | null {
    if (terminal) return null
    const event: ChatProgressEvent = {
      version: 1,
      eventId: `${runId}:${ordinal}`,
      runId,
      ordinal,
      activityId: update.activityId,
      phase: update.phase,
      status: update.status ?? "active",
      label: update.label,
      message: update.message,
      ...(update.toolName ? { toolName: update.toolName } : {}),
      ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
    }
    ordinal += 1
    if (event.phase === "completed" || event.phase === "cancelled" || event.phase === "failed") terminal = true
    write({
      type: "data-chat-progress",
      id: event.eventId,
      data: event,
      transient: false,
    })
    return event
  }

  const callbacks: ChatProgressCallbacks = {
    waiting: (stepNumber) => {
      emit({
        activityId: "model",
        phase: "waiting",
        label: "Model",
        message: stepNumber === 0 ? "Waiting for the model…" : "Waiting for the model to continue…",
      })
    },
    composing: () => {
      emit({ activityId: "model", phase: "composing", label: "Answer", message: "Composing the answer…" })
    },
    recovering: (message) => {
      emit({ activityId: "recovery", phase: "recovering", label: "Recovery", message: message || "Recovering the response…" })
    },
    toolStarted: (toolName, toolCallId, input) => {
      toolNames.set(toolCallId, toolName)
      emit({
        activityId: `tool:${toolCallId}`,
        phase: "tool",
        label: toolLabel(toolName),
        message: toolLoadingMessage(toolName, input),
        toolName,
        toolCallId,
      })
    },
    toolFinished: (toolName, toolCallId, success, output) => {
      const resultMessage = success ? toolResultMessage(toolDisplayRegistry[toolName], output) : null
      emit({
        activityId: `tool:${toolCallId}`,
        phase: "tool",
        status: success ? "completed" : "failed",
        label: toolLabel(toolName),
        message: resultMessage || (success ? "Tool finished" : "Tool failed"),
        toolName,
        toolCallId,
      })
    },
    analysisPhase: (toolCallId, phase) => {
      const messages = {
        provisioning: "Provisioning the analysis workspace…",
        uploading: "Uploading analysis files…",
        running: "Running the analysis…",
        reading: "Reading the analysis results…",
      } as const
      emit({
        activityId: `tool:${toolCallId}`,
        phase,
        label: "Analysis",
        message: messages[phase],
        toolName: toolNames.get(toolCallId) ?? "analysis_run_code",
        toolCallId,
      })
    },
    completed: () => { emit({ activityId: "run", phase: "completed", status: "completed", label: "Done", message: "Answer complete" }) },
    cancelled: () => { emit({ activityId: "run", phase: "cancelled", status: "cancelled", label: "Stopped", message: "Response cancelled" }) },
    failed: (message) => { emit({ activityId: "run", phase: "failed", status: "failed", label: "Failed", message: message || "The response failed" }) },
  }

  return {
    emit,
    callbacks,
    preparing: () => emit({ activityId: "run", phase: "preparing", label: "Request", message: "Preparing your request…" }),
    completed: callbacks.completed,
    cancelled: callbacks.cancelled,
    failed: callbacks.failed,
    isTerminal: () => terminal,
  }
}
