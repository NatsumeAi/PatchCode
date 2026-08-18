export * as SkillTrustTool from "./skill-trust"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { scanForThreatsInScope } from "../memory/scan"
import { Permission } from "../permission"
import { Skill as CoreSkill } from "../skill"
import { SkillLock } from "../skill/lock"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill_trust"

const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "Quarantined skill name to activate after a threat scan" }),
})

const Output = Schema.Struct({
  name: Schema.String,
  state: Schema.Literal("active"),
  sha256: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* Permission.Service
    const skills = yield* CoreSkill.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Activate a quarantined skill after a threat scan. Threaty content stays quarantined.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: `Trusted skill ${output.name}` }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "skill",
                  resources: [input.name],
                  save: [input.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: skill" })))
              const row = yield* Effect.promise(() => SkillLock.get(input.name, global.config))
              if (!row) return yield* new ToolFailure({ message: `Unknown skill: ${input.name}` })
              const skillFile = path.join(SkillLock.skillsDir(global.config), row.name, "SKILL.md")
              const body = yield* fs.readFileStringSafe(skillFile)
              if (!body) return yield* new ToolFailure({ message: `Skill file missing: ${input.name}` })
              const threats = scanForThreatsInScope(body, "context")
              if (threats.length > 0) {
                return yield* new ToolFailure({ message: `Skill ${input.name} failed threat scan` })
              }
              const sha256 = SkillLock.hashText(body)
              yield* Effect.promise(() => SkillLock.upsert({ ...row, state: "active", sha256 }, global.config))
              yield* skills.reload()
              return { name: row.name, state: "active" as const, sha256 }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill-trust",
  layer,
  deps: [ToolRegistry.node, Permission.node, CoreSkill.node, FSUtil.node, Global.node],
})
