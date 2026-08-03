export function normalizeToolName(tool: string): string {
  const t = tool.toLowerCase()
  if (t === "bash") return "shell"
  if (t === "apply_patch") return "patch"
  return t
}
