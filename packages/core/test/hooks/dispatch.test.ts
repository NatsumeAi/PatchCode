import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { dispatch } from "@opencode-ai/core/hooks"
import { it } from "../lib/effect"

describe("W5 dispatch order", () => {
  it.live("first allow second deny stops", () =>
    Effect.gen(function* () {
      const ran: string[] = []
      const decision = yield* dispatch({
        event: "PreToolUse",
        sessionID: "ses_d",
        cwd: "/",
        toolName: "read",
        specs: [],
        handlers: [
          {
            id: "a",
            event: "PreToolUse",
            run: () =>
              Effect.sync(() => {
                ran.push("a")
                return { _tag: "Allow" as const }
              }),
          },
          {
            id: "b",
            event: "PreToolUse",
            run: () =>
              Effect.sync(() => {
                ran.push("b")
                return { _tag: "Deny" as const, reason: "no", hookId: "b" }
              }),
          },
        ],
      })
      expect(decision._tag).toBe("Deny")
      expect(ran).toEqual(["a", "b"])
    }),
  )

  it.live("first deny skips second", () =>
    Effect.gen(function* () {
      const ran: string[] = []
      yield* dispatch({
        event: "PreToolUse",
        sessionID: "ses_d",
        cwd: "/",
        toolName: "read",
        specs: [],
        handlers: [
          {
            id: "a",
            event: "PreToolUse",
            run: () =>
              Effect.sync(() => {
                ran.push("a")
                return { _tag: "Deny" as const, reason: "no", hookId: "a" }
              }),
          },
          {
            id: "b",
            event: "PreToolUse",
            run: () =>
              Effect.sync(() => {
                ran.push("b")
                return { _tag: "Allow" as const }
              }),
          },
        ],
      })
      expect(ran).toEqual(["a"])
    }),
  )
})
