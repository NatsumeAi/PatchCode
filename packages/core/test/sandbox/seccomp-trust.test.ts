import { describe, expect, test } from "bun:test"
import { Trust } from "../../src/trust"
import { buildSeccompProgram, loadSeccompBpf, seccompBpfPath } from "../../src/sandbox/linux-seccomp"

describe("Trust interactivity", () => {
  test("isInteractive is false in CI", () => {
    const previous = process.env.CI
    process.env.CI = "true"
    expect(Trust.isInteractive()).toBe(false)
    if (previous === undefined) delete process.env.CI
    else process.env.CI = previous
  })

  test("isInteractive is false under bun test", () => {
    expect(Trust.isInteractive()).toBe(false)
  })
})

describe("linux seccomp artifact", () => {
  test("committed BPF exists and matches the generator", () => {
    const bytes = loadSeccompBpf()
    expect(bytes).toBeDefined()
    expect(bytes!.length).toBeGreaterThan(16)
    expect(bytes).toEqual(buildSeccompProgram(process.arch === "arm64" ? "arm64" : "x64"))
    expect(seccompBpfPath().endsWith(".bpf")).toBe(true)
  })
})
