import { describe, test, expect } from "bun:test"
import { LLMEvent, LLMResponse, Model, type LLMClientShape } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect } from "effect"
import { Verifier } from "../../src/session/runner/verifier"

describe("Verifier", () => {
  test("make returns a Verifier with sessionID + goal + rejectCount=0", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.make({ parentSessionID: "p-sess", goal: "Fix bug X in module Y" })
      expect(v.props.sessionID).toMatch(/^verifier-p-sess-/)
      expect(v.props.goal).toBe("Fix bug X in module Y")
      expect(v.props.rejectCount).toBe(0)
    }).pipe(Effect.runPromise),
  )

  test("audit returns shape { verdict, reason } and verdict ∈ {approved, rejected}", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      const out = yield* v.audit({ worker_claim: "Done.", worker_diff_path: "/d" })
      expect(["approved", "rejected"]).toContain(out.verdict)
      expect(typeof out.reason).toBe("string")
    }).pipe(Effect.runPromise),
  )

  test("provider auditor receives the goal and real worker evidence", async () => {
    const seen: { goal?: string; claim?: string; diff?: string } = {}
    const v = await Effect.runPromise(
      Verifier.make({
        parentSessionID: "p",
        goal: "Fix the parser",
        auditor: ({ goal, claim, diff }) =>
          Effect.sync(() => {
            seen.goal = goal
            seen.claim = claim
            seen.diff = diff
            return { verdict: "approved", reason: "Evidence matches" as const }
          }),
      }),
    )

    await Effect.runPromise(
      v.audit({
        worker_claim: "Implemented the parser fix and ran the tests.",
        worker_diff_path: "src/parser.ts: changed token recovery",
      }),
    )

    expect(seen).toEqual({
      goal: "Fix the parser",
      claim: "Implemented the parser fix and ran the tests.",
      diff: "src/parser.ts: changed token recovery",
    })
  })

  test("provider auditor decodes the structured verifier response", async () => {
    const requests: string[] = []
    const client: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => {
        throw new Error("unused")
      },
      generate: (request) => {
        requests.push(request.messages.map((message) => JSON.stringify(message.content)).join("\n"))
        const response = LLMResponse.fromEvents([
          LLMEvent.toolCall({
            id: "audit-call",
            name: "generate_object",
            input: { verdict: "rejected", reason: "Missing test evidence" },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ])
        if (!response) return Effect.die("test response did not finish")
        return Effect.succeed(response)
      },
    }
    const model = Model.make({ id: "verifier-model", provider: "test", route: OpenAIChat.route })
    const auditor = Verifier.makeProviderAuditor(model, client)

    const response = await Effect.runPromise(
      auditor({ goal: "Fix the parser", claim: "Done", diff: "parser.ts changed" }),
    )

    expect(response).toEqual({ verdict: "rejected", reason: "Missing test evidence" })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("Fix the parser")
    expect(requests[0]).toContain("parser.ts changed")
  })

  test("verifier instance persists across audits (sessionID stable)", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      const id1 = v.props.sessionID
      yield* v.audit({ worker_claim: "1", worker_diff_path: "d1" })
      yield* v.audit({ worker_claim: "2", worker_diff_path: "d2" })
      expect(v.props.sessionID).toBe(id1)
    }).pipe(Effect.runPromise),
  )

  test("mock-always-reject: audit increments rejectCount", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      expect(v.props.rejectCount).toBe(0)
      yield* v.audit({ worker_claim: "1", worker_diff_path: "d1" })
      expect(v.props.rejectCount).toBe(1)
      yield* v.audit({ worker_claim: "2", worker_diff_path: "d2" })
      expect(v.props.rejectCount).toBe(2)
    }).pipe(Effect.runPromise),
  )

  test("after 8 rejects, 9th audit fails with VerifierRejectedTooManyTimes", async () => {
    const run = Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      for (let i = 0; i < 8; i++) {
        yield* v.audit({ worker_claim: `attempt ${i}`, worker_diff_path: `diff${i}` })
      }
      // 9th audit: rejectCount already 8 → fail
      yield* v.audit({ worker_claim: "9th", worker_diff_path: "diff9" })
    }).pipe(Effect.runPromiseExit)
    const exit = await run
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = exit.cause
      expect(err).toBeDefined()
    }
  })

  test("dispose is callable and returns void", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      yield* v.dispose
    }).pipe(Effect.runPromise),
  )
})
