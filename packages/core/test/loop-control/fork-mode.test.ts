import { it, expect } from "bun:test"
import { Effect } from "effect"
import { buildForkPrompt } from "../../src/session/loop-control/fork-mode"

it("ForkMode.FullHistory: child 接收 parent 完整 trace", () =>
  Effect.gen(function* () {
    const out = yield* buildForkPrompt({
      mode: "FullHistory",
      parentTrace: [
        { role: "user", content: "fix x" },
        { role: "assistant", content: "..." },
      ],
      promptOverride: undefined,
    })
    expect(out).toContain("fix x")
    expect(out).toContain("...")
  }).pipe(Effect.runPromise),
)

it("ForkMode.PromptOnly: child 不接收 parent trace", () =>
  Effect.gen(function* () {
    const out = yield* buildForkPrompt({
      mode: "PromptOnly",
      parentTrace: [{ role: "user", content: "fix x" }],
      promptOverride: "do specific task Y",
    })
    expect(out).toBe("do specific task Y")
    expect(out).not.toContain("fix x")
  }).pipe(Effect.runPromise),
)
