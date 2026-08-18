import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayConfig } from "./config"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel, ToolFamily } from "./mode"

export interface DisplayContext {
  cwd: string
  width: number
  config: DisplayConfig
  /** Format a path for display (shorten relative to cwd) */
  formatPath(path: string): string
}

export interface ToolDescriptor {
  /** Primary name + aliases, lookup all lowercase */
  names: string[]
  family: ToolFamily
  policy(cfg: DisplayConfig): DisplayPolicy
  header(part: ToolPart, ctx: DisplayContext): HeaderModel
  body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel
  /** Optional: whether completed state counts as logical failure (shell exit!=0) */
  logicalError?(part: ToolPart): boolean
}

const registry = new Map<string, ToolDescriptor>()

export function registerDescriptor(descriptor: ToolDescriptor): void {
  for (const name of descriptor.names) {
    registry.set(name.toLowerCase(), descriptor)
  }
}

export function getDescriptor(normalizedTool: string): ToolDescriptor | undefined {
  return registry.get(normalizedTool)
}

export function listDescriptors(): ToolDescriptor[] {
  const seen = new Set<ToolDescriptor>()
  for (const d of registry.values()) {
    seen.add(d)
  }
  return [...seen]
}
