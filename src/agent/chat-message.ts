import type { UIMessage } from "ai"

export type ChatProgressPhase =
  | "preparing"
  | "waiting"
  | "tool"
  | "provisioning"
  | "uploading"
  | "running"
  | "reading"
  | "recovering"
  | "composing"
  | "completed"
  | "cancelled"
  | "failed"

export type ChatProgressStatus = "active" | "completed" | "cancelled" | "failed"

export type ChatProgressEvent = {
  version: 1
  eventId: string
  runId: string
  ordinal: number
  activityId: string
  phase: ChatProgressPhase
  status: ChatProgressStatus
  label: string
  message: string
  toolName?: string
  toolCallId?: string
}

export type ChatMessageData = {
  "chat-progress": ChatProgressEvent
}

export type ChatMessageMetadata = {
  finishReason?: string
  turnGeneration?: number
}

export type ChatMessage = UIMessage<ChatMessageMetadata, ChatMessageData>
