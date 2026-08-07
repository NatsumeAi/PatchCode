import { describe, expect, test } from "bun:test"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { MemoryContext } from "../../src/memory/context"
import { MemoryTools } from "../../src/memory/tools"

describe("Memory wiring", () => {
  test("built-in tools node includes memory tools", () => {
    expect(BuiltInTools.node.dependencies.some((dep) => dep.name === "memory-tools")).toBe(true)
  })

  test("memory nodes expose the expected names for the location-services wiring gate", () => {
    expect(MemoryContext.node.name).toBe("memory-context")
    expect(MemoryTools.node.name).toBe("memory-tools")
  })
})

test("location services group includes memory nodes", () => {
  const { locationServices } = require("../../src/location-services")
  const names = locationServices.dependencies.map((d: { name: string }) => d.name)
  expect(names).toContain("memory-context")
  expect(names).toContain("memory-drain-watcher")
  expect(names).toContain("memory-flush")
})
