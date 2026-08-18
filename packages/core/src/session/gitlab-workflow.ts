export * as GitLabWorkflow from "./gitlab-workflow"

import { Context, Effect, Runtime } from "effect"

/**
 * Live host for GitLab Duo workflow extras that leftover LLM.stream used to
 * attach onto GitLabWorkflowLanguageModel (toolExecutor / preapproved tools /
 * workflow_tool_approval). SessionRunner installs a session slot around
 * llm.stream; GitLabPlugin language hook reads the slot (language creation
 * may not see Effect.serviceOption on the stream fiber).
 */
export interface Host {
  readonly sessionID: string
  readonly systemPrompt: string
  readonly sessionPreapprovedTools: readonly string[]
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
  readonly toolExecutor: (
    toolName: string,
    argsJson: string,
    requestID: string,
  ) => Effect.Effect<{
    readonly result: string
    readonly error?: string
    readonly metadata?: unknown
    readonly title?: string
  }>
  readonly approvalHandler: (approvalTools: ReadonlyArray<{ readonly name: string; readonly args: string }>) => Effect.Effect<{
    readonly approved: boolean
  }>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/GitLabWorkflow.Host") {}

const hosts = new Map<string, Host>()

export const install = (host: Host) => {
  hosts.set(host.sessionID, host)
}

export const uninstall = (sessionID: string) => {
  hosts.delete(sessionID)
}

export const current = (sessionID?: string) => {
  if (sessionID) return hosts.get(sessionID)
  if (hosts.size === 1) return hosts.values().next().value
  return undefined
}

export const runWith = <A, E>(runtime: Runtime.Runtime<never>, effect: Effect.Effect<A, E>) =>
  Runtime.runPromise(runtime)(effect as Effect.Effect<A, E, never>)
