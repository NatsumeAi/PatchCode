import { it, expect } from "bun:test"
import { parseEvalArgs } from "@/cli/cmd/eval/eval"

it("--smoke=true 强制 batchSize=5 + instancesRange=0-4", () => {
  const a = parseEvalArgs({
    smoke: true,
    model: "kimi/kimi-k3",
    forkCommit: "abc",
    dataset: "swe-bench-verified",
  })
  expect(a.batchSize).toBe(5)
  expect(a.instancesRange).toEqual({ start: 0, end: 4 })
})

it("--smoke=false 不强制", () => {
  const a = parseEvalArgs({
    smoke: false,
    model: "kimi/kimi-k3",
    forkCommit: "abc",
    dataset: "swe-bench-verified",
    instancesRange: "100-199",
  })
  expect(a.instancesRange).toEqual({ start: 100, end: 199 })
})
