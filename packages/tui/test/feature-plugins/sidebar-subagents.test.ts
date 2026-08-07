import { describe, expect, test } from "bun:test"
import { subagentsOf } from "../../src/feature-plugins/sidebar/subagents"

describe("subagentsOf", () => {
  test("filters by parentID and sorts working first", () => {
    const sessions = [
      { id: "p", title: "parent" },
      { id: "c1", parentID: "p", title: "a", agent: "explore" },
      { id: "c2", parentID: "p", title: "b", agent: "general" },
      { id: "other", parentID: "x", title: "nope" },
    ]
    const list = subagentsOf(sessions, "p", (id) => id === "c2")
    expect(list.map((s) => s.id)).toEqual(["c2", "c1"])
  })
})
