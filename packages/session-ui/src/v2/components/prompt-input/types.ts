import type { FilePartSource } from "@opencode-ai/sdk/api/client"

type PromptInputPartBase = {
  content: string
  start: number
  end: number
}

export type PromptInputTextPart = PromptInputPartBase & {
  type: "text"
}

export type PromptInputFilePart = PromptInputPartBase & {
  type: "file"
  path: string
  selection?: PromptInputSelection
  mime?: string
  filename?: string
  url?: string
  source?: FilePartSource
}

export type PromptInputAgentPart = PromptInputPartBase & {
  type: "agent"
  name: string
}

export type PromptInputAttachment = {
  type: "image"
  id: string
  filename: string
  sourcePath?: string
  mime: string
  dataUrl: string
}

export type PromptInputPrompt = (
  | PromptInputTextPart
  | PromptInputFilePart
  | PromptInputAgentPart
  | PromptInputAttachment
)[]

export type PromptInputModel = {
  providerID: string
  modelID: string
  variant?: string | null
}

export type PromptInputSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export type PromptInputComment = {
  type: "file"
  key: string
  path: string
  selection?: PromptInputSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type PromptInputPersistedState = {
  prompt: PromptInputPrompt
  cursor?: number
  model?: PromptInputModel
  context: {
    items: PromptInputComment[]
  }
}

export type PromptInputHistoryEntry = {
  prompt: PromptInputPrompt
  metadata?: unknown
}

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptInputHistoryEntry[]
  add: (prompt: PromptInputPrompt, mode: "normal" | "shell") => void
  capture?: () => unknown
  restore?: (metadata: unknown) => void
}

export type PromptInputOption = {
  id: string
  label: string
  providerID?: string
}

export type PromptInputSuggestion = {
  id: string
  kind: "agent" | "command" | "file" | "reference" | "resource"
  label: string
  title?: string
  trigger?: string
  description?: string
  path?: string
  keybind?: string[]
  recent?: boolean
  mention?: PromptInputFilePart | PromptInputAgentPart
}
