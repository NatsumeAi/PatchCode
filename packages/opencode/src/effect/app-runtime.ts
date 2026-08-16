import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { CredentialBridge } from "@/auth/credential-bridge"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { AppNodeBuilderInstance } from "./instance-app-node-builder"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import { SubagentRegistry } from "@opencode-ai/core/session/subagent-registry"
import { ToolHostBridges } from "@/tool/tool-host-bridges"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { MemoryDrainWatcher } from "@opencode-ai/core/memory/drain-watcher"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"

const locationServiceMapV2 = buildLocationServiceMap([
  [TaskTool.hostNode, ToolHostBridges.taskHostNode],
  [BashTool.hostNode, ToolHostBridges.bashHostNode],
])

export const AppLayer = AppNodeBuilderInstance.build(
  LayerNode.group([
    Npm.node,
    FSUtil.node,
    Database.node,
    Auth.node,
    Account.node,
    Config.node,
    Git.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelsDev.node,
    Provider.node,
    ProviderAuth.node,
    CredentialBridge.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    Todo.node,
    Session.node,
    SessionProjector.node,
    SessionStatus.node,
    BackgroundJob.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    SessionRunState.node,
    SessionSummary.node,

    LSP.node,
    MCP.node,
    McpAuth.node,
    Command.node,

    Format.node,
    InstanceStore.node,
    Project.node,
    Vcs.node,
    Workspace.node,
    Worktree.node,
    Installation.node,
    ShareNext.node,
    SessionShare.node,
    SessionV2.node,
    ToolHostBridges.node,
    SubagentRegistry.node,
    MemoryDrainWatcher.node,
  ]),
  [
    [LocationServiceMap.node, locationServiceMapV2],
    [SessionExecution.node, SessionExecutionLocal.node],
    [TaskTool.hostNode, ToolHostBridges.taskHostNode],
  ],
).pipe(
  Layer.provide(locationServiceMapV2),
  Layer.provideMerge(AppNodeBuilderInstance.build(Ripgrep.node)),
  Layer.provideMerge(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
  Layer.provideMerge(Observability.layer),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
