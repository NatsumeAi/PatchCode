import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, num, str, toolOutputText } from "./shared"
import { truncateText } from "../header-utils"

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return {
    streaming: "collapsed",
    finished: "collapsed",
    error: "collapsed",
    foldable: true,
    foldCycle: "two",
  }
}

function webSearchProviderLabel(provider: unknown): string {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function headerFetch(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = inputOf(part)
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
  const inp = inputOf(part)
  const meta = metadataOf(part)
  const query = str(inp.query) ?? ""
  // numResults lives on input (runtime); structured is { provider, text }
  const numResults = num(inp.numResults) ?? num(meta.numResults)
  const details = numResults != null ? `(${numResults} results)` : ""
  return {
    verb: webSearchProviderLabel(meta.provider),
    icon: "\u25C8",
    family: "web",
    primary: query ? `"${query}"` : "",
    details,
    muted: false,
    status: part.state.status,
    accent: "web",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = toolOutputText(part)
  if (output.trim()) return { kind: "text", text: output, maxLines: 30 }
  // websearch structured.text when content was empty
  const text = str(metadataOf(part).text)
  if (text?.trim()) return { kind: "text", text, maxLines: 30 }
  return { kind: "none" }
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
