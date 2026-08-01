export * as Verifier from "./verifier"

import { LLM, LLMClient, type LLMClientShape, type LLMError, type Model } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"

/**
 * L3 Verifier — independent LLM session that audits worker "done" claims.
 *
 * Lifecycle: `make(...)` creates one Verifier instance per loop; the same
 * instance survives across audits (sessionID stable) so the verifier sees the
 * full reject/retry history. `dispose` is called on harness break / hard abort.
 *
 * `audit(claim)` calls the underlying LLM with `goal + claim + diff` and
 * returns `{ verdict, reason, evidence? }`. Mock mode (this task) uses a
 * configurable static verdict; Task 2 wires the real LLM call. After 8 rejects
 * `audit` fails with `VerifierRejectedTooManyTimes` to break the loop.
 *
 * Per docs/loop-design.md §1b/c/d: Claude Code `/goal` Haiku Stop hook;
 * Devin Review "coding and review agents do not share any context beforehand";
 * Cursor Auto-review same-stream classifier.
 *
 * Plan 3 Task 1: mock impl; Task 2 adds real LLM + bi-directional EventBus;
 * Task 3 closes the done-decision loop.
 */

const VERIFIER_REJECT_CAP = 8

export const VerifierResponse = Schema.Struct({
  verdict: Schema.Literals(["approved", "rejected"]),
  reason: Schema.String,
  evidence: Schema.optional(
    Schema.Array(
      Schema.Struct({
        file: Schema.String,
        line: Schema.optional(Schema.Number),
        issue: Schema.String,
      }),
    ),
  ),
})
export type VerifierResponse = typeof VerifierResponse.Type

export interface WorkerClaim {
  readonly worker_claim: string
  readonly worker_diff_path: string
  readonly worker_diff?: string
}

export interface AuditorInput {
  readonly goal: string
  readonly claim: string
  readonly diff: string
}

export type Auditor = (input: AuditorInput) => Effect.Effect<VerifierResponse, LLMError>

export const makeProviderAuditor = (model: Model, client: LLMClientShape): Auditor => (input) =>
  LLM.generateObject({
    model,
    system: "You are an independent coding verifier. Approve only when the goal is satisfied by the evidence.",
    prompt: [`Goal: ${input.goal}`, `Worker claim: ${input.claim}`, `Changed files: ${input.diff}`].join("\n\n"),
    schema: VerifierResponse,
  }).pipe(
    Effect.provideService(LLMClient.Service, client),
    Effect.map((result) => result.object),
  )

export class VerifierRejectedTooManyTimes extends Schema.TaggedErrorClass<VerifierRejectedTooManyTimes>()(
  "LoopControl.Verifier.RejectedTooManyTimes",
  { n: Schema.Number },
) {}

export interface VerifierProps {
  readonly sessionID: string
  readonly goal: string
  rejectCount: number
}

export interface VerifierImpl {
  readonly props: VerifierProps
  readonly audit: (
    claim: WorkerClaim,
  ) => Effect.Effect<VerifierResponse, VerifierRejectedTooManyTimes | LLMError>
  readonly dispose: Effect.Effect<void>
}

export const make = (opts: {
  parentSessionID: string
  goal: string
  verdict?: "approved" | "rejected"
  reason?: string
  auditor?: Auditor
}): Effect.Effect<VerifierImpl> =>
  Effect.gen(function* () {
    const sessionID = `verifier-${opts.parentSessionID}-${Math.random().toString(36).slice(2, 10)}`
    const props: VerifierProps = {
      sessionID,
      goal: opts.goal,
      rejectCount: 0,
    }
    const mockVerdict = opts.verdict ?? "rejected"
    const mockReason = opts.reason ?? "Specific issue X"

    const audit: VerifierImpl["audit"] = (claim) =>
      Effect.gen(function* () {
        if (props.rejectCount >= VERIFIER_REJECT_CAP) {
          return yield* Effect.fail(new VerifierRejectedTooManyTimes({ n: props.rejectCount }))
        }
        const response = opts.auditor
          ? yield* opts.auditor({
              goal: props.goal,
              claim: claim.worker_claim,
              diff: claim.worker_diff ?? claim.worker_diff_path,
            })
          : {
              verdict: mockVerdict,
              reason: mockVerdict === "approved" ? "All checks pass" : mockReason,
            }
        if (response.verdict === "rejected") {
          props.rejectCount += 1
        }
        return response
      })

    const dispose: VerifierImpl["dispose"] = Effect.void

    return { props, audit, dispose }
  })

// Test helpers — convenience factories so tests don't need to pass verdict/reason.
export const makeAlwaysReject = (parentSessionID: string, goal: string): Effect.Effect<VerifierImpl> =>
  make({ parentSessionID, goal, verdict: "rejected", reason: "Specific issue X" })

export const makeAlwaysApprove = (parentSessionID: string, goal: string): Effect.Effect<VerifierImpl> =>
  make({ parentSessionID, goal, verdict: "approved", reason: "All checks pass" })
