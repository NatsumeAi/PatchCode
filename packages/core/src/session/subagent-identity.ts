export * as SubagentIdentity from "./subagent-identity"

import { SessionSchema } from "./schema"

/**
 * Validate that a task_id resume targets a session this parent spawned with a
 * matching agent type (and optional persona pin).
 * 1. child.parentID === parentSessionID (only resume your own children)
 * 2. child.agent === subagentType (agent name match)
 * 3. model soft-ignore: requestedModel differs from child.model → caller must
 *    use the child's model (source pinning), not the requested one.
 * 4. persona: if request names a persona different from prior → reject;
 *    if request omits persona → inherit prior (ok).
 */
export function validateResumeIdentity(input: {
  child: SessionSchema.Info
  parentSessionID: SessionSchema.ID
  subagentType: string
  requestedModel?: { modelID: string; providerID: string }
  requestedPersona?: string
  priorPersonaName?: string
  priorFingerprint?: string
  /** When set with priorFingerprint, reject if instructions drifted. */
  requestedFingerprint?: string
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
  if (
    input.requestedPersona !== undefined &&
    input.priorPersonaName !== undefined &&
    input.requestedPersona !== input.priorPersonaName
  ) {
    return {
      ok: false,
      reason: `Task session ${input.child.id} persona "${input.priorPersonaName}" does not match resume persona "${input.requestedPersona}"`,
    }
  }
  // Fingerprint drift: when both prior and requested fingerprints are known and differ, reject.
  // Callers that omit requestedFingerprint skip drift check (inherit prior instructions).
  if (
    input.priorFingerprint !== undefined &&
    input.requestedFingerprint !== undefined &&
    input.priorFingerprint !== input.requestedFingerprint
  ) {
    return {
      ok: false,
      reason: `Task session ${input.child.id} persona instructions fingerprint drifted (resume pin mismatch)`,
    }
  }
  // Model is soft-ignored: the caller must use the child's model (source pinning).
  return { ok: true, childModel: input.child.model }
}
