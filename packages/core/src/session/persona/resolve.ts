export * as PersonaResolve from "./resolve"

import { Effect } from "effect"
import { fingerprintInstructions } from "./fingerprint"
import type { EffectiveSubagentConfig, PersonaInfo } from "./schema"

export type ResolveInput = {
  readonly taskPersona?: string
  readonly agentDefaultPersona?: string
  readonly catalog: ReadonlyMap<string, PersonaInfo>
  /** Soft-fail body loader for instructions_file (returns undefined on miss). */
  readonly readFile?: (path: string) => Effect.Effect<string | undefined>
}

/**
 * Precedence: task override > agent default > none.
 */
export const resolve = (input: ResolveInput): Effect.Effect<EffectiveSubagentConfig> =>
  Effect.gen(function* () {
    const name = input.taskPersona?.trim() || input.agentDefaultPersona?.trim() || undefined
    if (!name) {
      return {
        instructions: "",
        source: "none" as const,
        fingerprint: fingerprintInstructions(""),
      }
    }
    const source = input.taskPersona?.trim()
      ? ("task_override" as const)
      : ("agent_default" as const)
    const info = input.catalog.get(name)
    if (!info) {
      // Soft-fail: named persona missing — empty instructions, keep name for resume pin.
      return {
        personaName: name,
        instructions: "",
        source,
        fingerprint: fingerprintInstructions(""),
      }
    }
    let body = info.instructions?.trim() ?? ""
    if (info.instructions_file && input.readFile) {
      const fileBody = yield* input.readFile(info.instructions_file)
      if (fileBody !== undefined && fileBody.trim()) {
        body = body ? `${body}\n\n${fileBody.trim()}` : fileBody.trim()
      }
      // missing file: soft-fail, keep inline only
    }
    return {
      personaName: name,
      instructions: body,
      source,
      path: info.instructions_file,
      fingerprint: fingerprintInstructions(body),
      inputs: info.inputs,
      outputs: info.outputs,
      capabilityTighten: info.capability,
    }
  })
