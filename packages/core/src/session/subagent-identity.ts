export * as SubagentIdentity from "./subagent-identity"

import { SessionSchema } from "./schema"

/**
 * Validate that a task_id resume targets a session this parent spawned with a
 * matching agent type. Three checks (AgentV2 has no persona concept yet):
 * 1. child.parentID === parentSessionID (only resume your own children)
 * 2. child.agent === subagentType (agent name match)
 * 3. model soft-ignore: requestedModel differs from child.model → caller must
 *    use the child's model (source pinning), not the requested one.
 */
export function validateResumeIdentity(input: {
  child: SessionSchema.Info
  parentSessionID: SessionSchema.ID
  subagentType: string
  requestedModel?: { modelID: string; providerID: string }
}): { ok: true; childModel: SessionSchema.Info["model"] } | { ok: false; reason: string } {
  if (input.child.parentID !== input.parentSessionID) {
    return {
      ok: false,
      reason: `Task session ${input.child.id} was not spawned by this session (parent ${input.child.parentID} !== ${input.parentSessionID})`,
    }
  }
  if (String(input.child.agent) !== input.subagentType) {
    return {
      ok: false,
      reason: `Task session ${input.child.id} is agent "${input.child.agent}" but resume requested "${input.subagentType}"`,
    }
  }
  // Model is soft-ignored: the caller must use the child's model (source pinning).
  return { ok: true, childModel: input.child.model }
}
