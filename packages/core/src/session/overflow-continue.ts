export * as OverflowContinue from "./overflow-continue"

export const CONTINUE_TEXT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

export const MEDIA_OVERFLOW_PREFIX =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"

export const continueText = (overflow: boolean) => (overflow ? MEDIA_OVERFLOW_PREFIX : "") + CONTINUE_TEXT

export const mediaPlaceholder = (mime: string, filename?: string) =>
  `[Attached ${mime}: ${filename ?? "file"}]`

export const isMedia = (mime: string) =>
  mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/pdf"

export type ReplayFile = {
  readonly mime: string
  readonly name?: string
}

/** Official leftover overflow replay: last user text + media replaced by placeholders. */
export const replayUserText = (input: { readonly text?: string; readonly files?: readonly ReplayFile[] }) => {
  const placeholders = (input.files ?? [])
    .filter((file) => isMedia(file.mime))
    .map((file) => mediaPlaceholder(file.mime, file.name))
  return [input.text?.trim() ? input.text : undefined, ...placeholders].filter((part): part is string => Boolean(part)).join("\n")
}

export const hasReplayableMedia = (files?: readonly ReplayFile[]) =>
  (files ?? []).some((file) => isMedia(file.mime))
