import os from "os"
import { InstallationVersion } from "../../installation/version"
import { Effect, Option } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"
import { GitLabWorkflow } from "../../session/gitlab-workflow"

export const GitLabPlugin = define({
  id: "gitlab",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "gitlab-ai-provider") return
        const mod = yield* Effect.promise(() => import("gitlab-ai-provider"))
        evt.sdk = mod.createGitLab({
          ...evt.options,
          instanceUrl:
            typeof evt.options.instanceUrl === "string"
              ? evt.options.instanceUrl
              : (process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com"),
          apiKey: typeof evt.options.apiKey === "string" ? evt.options.apiKey : process.env.GITLAB_TOKEN,
          aiGatewayHeaders: {
            "User-Agent": `opencode/${InstallationVersion} gitlab-ai-provider/${mod.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
            "anthropic-beta": "context-1m-2025-08-07",
            ...evt.options.aiGatewayHeaders,
          },
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...evt.options.featureFlags,
          },
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.gitlab) return
        const featureFlags =
          typeof evt.options.featureFlags === "object" && evt.options.featureFlags ? evt.options.featureFlags : {}
        if (evt.model.api.id.startsWith("duo-workflow-")) {
          const gitlab = yield* Effect.promise(() => import("gitlab-ai-provider")).pipe(Effect.orDie)
          const workflowRef =
            typeof evt.model.request.body.workflowRef === "string" ? evt.model.request.body.workflowRef : undefined
          const workflowDefinition =
            typeof evt.model.request.body.workflowDefinition === "string"
              ? evt.model.request.body.workflowDefinition
              : undefined
          const language = evt.sdk.workflowChat(
            gitlab.isWorkflowModel(evt.model.api.id) ? evt.model.api.id : "duo-workflow",
            {
              featureFlags,
              workflowDefinition,
            },
          )
          if (workflowRef) language.selectedModelRef = workflowRef
          const slotted = GitLabWorkflow.current()
          const hosted = yield* Effect.serviceOption(GitLabWorkflow.HostService)
          const host = slotted ?? (Option.isSome(hosted) ? hosted.value : undefined)
          if (host) {
            const workflow = language as typeof language & {
              sessionID?: string
              systemPrompt?: string
              sessionPreapprovedTools?: string[]
              toolExecutor?: (toolName: string, argsJson: string, requestID: string) => Promise<unknown>
              approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
            }
            workflow.sessionID = host.sessionID
            workflow.systemPrompt = host.systemPrompt
            workflow.sessionPreapprovedTools = [...host.sessionPreapprovedTools]
            workflow.toolExecutor = (toolName, argsJson, requestID) =>
              host.runPromise(host.toolExecutor(toolName, argsJson, requestID))
            workflow.approvalHandler = (approvalTools) => host.runPromise(host.approvalHandler(approvalTools))
          }
          evt.language = language
          return
        }
        evt.language = evt.sdk.agenticChat(evt.model.api.id, {
          aiGatewayHeaders: evt.options.aiGatewayHeaders,
          featureFlags,
        })
      }),
    )
  }),
})
