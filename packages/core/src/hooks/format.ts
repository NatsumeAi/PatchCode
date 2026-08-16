export const formatHooksStatus = (input: {
  readonly loaded: readonly { readonly id: string }[]
  readonly untrusted?: boolean
  readonly lastDeny?: { readonly hookId: string; readonly event: string; readonly reason: string }
}) => {
  const lines = ["Hooks"]
  if (input.untrusted) lines.push("project: untrusted")
  if (input.loaded.length === 0) lines.push("loaded: (none)")
  else lines.push(`loaded: ${input.loaded.map((item) => item.id).join(", ")}`)
  if (input.lastDeny) {
    lines.push(`last deny: ${input.lastDeny.hookId} ${input.lastDeny.event} ${input.lastDeny.reason}`)
  }
  return lines.join("\n")
}
