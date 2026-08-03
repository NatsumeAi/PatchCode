import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { truncateText } from "../header-utils"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: false }
}

function webSearchProviderLabel(provider: unknown): string {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function headerFetch(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const url = str(inp.url) ?? ""
  return {
    verb: "Fetch",
    icon: "%",
    family: "web",
    primary: truncateText(url, 60),
    details: "",
    muted: false,
    status: part.state.status,
    accent: "web",
  }
}

function headerSearch(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const meta = metadata(part)
  const query = str(inp.query) ?? ""
  const numResults = num(meta.numResults)
  const details = numResults != null ? `(${numResults} results)` : ""
  return {
    verb: webSearchProviderLabel(meta.provider),
    icon: "\u25C8",
    family: "web",
    primary: `"${query}"`,
    details,
    muted: false,
    status: part.state.status,
    accent: "web",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = part.state.status === "completed" ? part.state.output : ""
  if (!output.trim()) return { kind: "none" }
  return { kind: "text", text: output, maxLines: 20 }
}

export const webfetchDescriptor: ToolDescriptor = {
  names: ["webfetch"],
  family: "web",
  policy,
  header: headerFetch,
  body,
}

export const websearchDescriptor: ToolDescriptor = {
  names: ["websearch"],
  family: "web",
  policy,
  header: headerSearch,
  body,
}
