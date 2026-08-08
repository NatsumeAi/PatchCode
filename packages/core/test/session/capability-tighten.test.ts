import { expect, test } from "bun:test"
import { tightenCapability } from "../../src/session/subagent-permissions"

test("persona cannot widen agent execute to all", () => {
  expect(tightenCapability("execute", "all")).toBe("execute")
})

test("persona can tighten all to read-only", () => {
  expect(tightenCapability("all", "read-only")).toBe("read-only")
})

test("undefined persona keeps agent ceiling", () => {
  expect(tightenCapability("read-write", undefined)).toBe("read-write")
})

test("undefined agent uses persona", () => {
  expect(tightenCapability(undefined, "execute")).toBe("execute")
})
