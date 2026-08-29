export type ProviderOptions = Record<string, Record<string, string | number | boolean | null>>

export type ThinkingLevel = {
  key: string
  label: string
  providerOptions: ProviderOptions
}

export type GeneralChatModel = {
  id: string
  label: string
  contextWindow: number
  thinking?: {
    levels: ThinkingLevel[]
    default: ProviderOptions
  }
}

export const generalChatModels = {
  flash: {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
  },
} satisfies Record<string, GeneralChatModel>

export type GeneralChatModelKey = keyof typeof generalChatModels

export const DEFAULT_GENERAL_CHAT_MODEL: GeneralChatModelKey = "flash"

export function resolveGeneralChatModelKey(modelKey?: string): GeneralChatModelKey {
  return modelKey && modelKey in generalChatModels
    ? (modelKey as GeneralChatModelKey)
    : DEFAULT_GENERAL_CHAT_MODEL
}
