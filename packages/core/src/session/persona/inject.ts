export * as PersonaInject from "./inject"

import { Effect, Option } from "effect"
import { PersonaStore } from "./store"
import type { EffectiveSubagentConfig } from "./schema"
import { SessionSchema } from "../schema"

/**
 * Grok-style persona system block (see reference subagent_prompt.md):
 * <persona>\n${instructions}\n</persona>
 */
export function formatPersonaSystem(config: EffectiveSubagentConfig): string {
  const body = config.instructions.trim()
  if (!body) return ""
  return `<persona>\n${body}\n</persona>`
}

/** Resolve SystemPart text for a session from PersonaStore (empty when none). */
export const systemTextForSession = (
  sessionID: SessionSchema.ID | string,
): Effect.Effect<string | undefined, never, never> =>
  Effect.gen(function* () {
    const opt = yield* Effect.serviceOption(PersonaStore.Service)
    if (Option.isNone(opt)) return undefined
    const cfg = yield* opt.value.get(SessionSchema.ID.make(String(sessionID)))
    if (!cfg) return undefined
    const text = formatPersonaSystem(cfg)
    return text.length > 0 ? text : undefined
  })
