export * as DoneDecisionLoop from "./done-decision-loop"

import { type LLMError } from "@opencode-ai/llm"
import { Effect } from "effect"
import { EventBus } from "../loop-control/event-bus"
import { TerminalController } from "../loop-control/terminal-controller"
import { VerifierRejectedTooManyTimes, type VerifierImpl, type WorkerClaim, type VerifierResponse } from "./verifier"
import { VerifierBiDirectional } from "./verifier-bi-directional"

/**
 * L3 Done-decision loop closure (Plan 3 Task 3 + Plan 4 Task 2 terminal wiring).
 *
 * Closes the loop: worker turn ends with a "done" claim → harness calls
 * `onWorkerClaimComplete(verifier, claim)` → verifier.audit → if approved,
 * requests terminal state `verifier_approved` and returns `{ broken: true }`
 * so the caller breaks the loop; if rejected, injects the reason + evidence
 * into the worker's next-turn system context via `VerifierBiDirectional` and
 * returns `{ broken: false }` so the loop continues — the terminal controller
 * is left running so a later turn can still approve. On verifier failure
 * (provider error or rejection-cap exhaustion) the loop requests terminal
 * state `unrecoverable_failure` and rethrows so the harness can publish
 * `HardAbort` exactly as before.
 *
 * The verifier is per-loop state carried explicitly; the only ambient deps
 * are the `VerifierBiDirectional` Service (per-loop reject-reason queue) and
 * the `TerminalController` Service (the single terminal-state authority).
 *
 * Per docs/loop-design.md §1b/c/d: break the loop only when the verifier
 * approves, never on the worker's self-claim alone.
 */

export interface DoneDecisionOutcome {
  readonly broken: boolean
}

const requestUnrecoverableFailure = <E>(err: E): Effect.Effect<never, E, TerminalController.Interface> =>
  Effect.gen(function* () {
    yield* TerminalController.request("unrecoverable_failure")
    return yield* Effect.fail(err)
  })

export const onWorkerClaimComplete = (
  v: VerifierImpl,
  claim: WorkerClaim,
): Effect.Effect<
  DoneDecisionOutcome,
  VerifierRejectedTooManyTimes | LLMError,
  VerifierBiDirectional.Interface | EventBus.Interface | TerminalController.Interface
> =>
  Effect.gen(function* () {
    const resp: VerifierResponse = yield* v.audit(claim).pipe(
      Effect.catchTag("LoopControl.Verifier.RejectedTooManyTimes", requestUnrecoverableFailure),
      Effect.catchTag("LLM.Error", requestUnrecoverableFailure),
    )
    if (resp.verdict === "approved") {
      yield* TerminalController.request("verifier_approved")
      return { broken: true }
    }
    yield* VerifierBiDirectional.injectRejectReasonToWorkerContext(resp.reason, resp.evidence)
    return { broken: false }
  })
