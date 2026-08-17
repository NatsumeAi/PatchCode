import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { ToolHostBridges } from "@/tool/tool-host-bridges"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { BashTool } from "@opencode-ai/core/tool/bash"

export const appLocationServiceMap = buildLocationServiceMap([
  [TaskTool.hostNode, ToolHostBridges.taskHostNode],
  [BashTool.hostNode, ToolHostBridges.bashHostNode],
])
