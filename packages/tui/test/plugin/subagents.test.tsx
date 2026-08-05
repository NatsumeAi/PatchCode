import { expect, test } from "bun:test"
import { subagentsOf } from "../../src/feature-plugins/sidebar/subagents"

const sessions = [
  { id: "ses_parent", parentID: undefined },
  { id: "ses_child_working", parentID: "ses_parent" },
  { id: "ses_child_done", parentID: "ses_parent" },
  { id: "ses_other", parentID: "ses_other_parent" },
] as const

test("filters sessions to the ones this session spawned", () => {
  const result = subagentsOf(sessions, "ses_parent", () => false)
  expect(result.map((item) => item.id)).toEqual(["ses_child_working", "ses_child_done"])
})

test("excludes sessions of other parents", () => {
  const result = subagentsOf(sessions, "ses_other_parent", () => false)
  expect(result.map((item) => item.id)).toEqual(["ses_other"])
})

test("sorts working subagents first", () => {
  const result = subagentsOf(sessions, "ses_parent", (id) => id === "ses_child_working")
  expect(result.map((item) => item.id)).toEqual(["ses_child_working", "ses_child_done"])
})

test("returns empty for a session without subagents", () => {
  const result = subagentsOf(sessions, "ses_none", () => false)
  expect(result).toEqual([])
})
