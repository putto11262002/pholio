import type { UIMessage } from "ai"

export type ChatMessageMetadata = {
  finishReason?: string
  turnGeneration?: number
}

export type ChatMessage = UIMessage<ChatMessageMetadata>
