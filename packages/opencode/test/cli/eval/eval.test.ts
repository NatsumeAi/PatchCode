import { it, expect } from "bun:test"
import { parseEvalArgs, EvalArgError, BASELINE_COMMIT_LOCK } from "@/cli/cmd/eval/eval"
import { buildEvalDriverInvocation } from "@/cli/cmd/eval/runner"

it("eval args 解析 baseline-commit 默认 = fork base 锁定 commit", () => {
  const a = parseEvalArgs({
    dataset: "swe-bench-verified",
    batchSize: 5,
    concurrency: 2,
    model: "kimi/kimi-k3",
    instancesRange: "0-4",
    forkCommit: "abc123",
  })
  expect(a.baselineCommit).toBe("f7204902192624481e526b1852cdedaadb914e24")
  expect(a.forkCommit).toBe("abc123")
  expect(a.instancesRange).toEqual({ start: 0, end: 4 })
})

it("缺 model 抛 EvalArgError", () => {
  expect(() => parseEvalArgs({ dataset: "swe-bench-verified" } as Record<string, unknown>)).toThrow()
})

it("eval driver invocation resolves the parent driver and forwards run controls", () => {
  const args = parseEvalArgs({
    model: "tjg/glm-5.2",
    instancesRange: "2-4",
    forkCommit: "fork123",
    forkBin: "/tmp/fork-opencode",
    baselineBin: "/tmp/baseline-opencode",
    batchSize: 7,
    concurrency: 3,
    repoCache: "/tmp/cache",
    out: "/tmp/results.json",
  })

  const invocation = buildEvalDriverInvocation(args, "/home/huyongjun/openpartner/opencode/packages/opencode")
  expect(invocation.cwd).toBe("/home/huyongjun/openpartner/docs/superpowers/plans/baseline-driver")
  expect(invocation.cmd).toEqual([
    "python3",
    "-m",
    "lib.main",
    "--instance-indices",
    "2,3,4",
    "--baseline-commit",
    "f7204902192624481e526b1852cdedaadb914e24",
    "--fork-commit",
    "fork123",
    "--batch-size",
    "7",
    "--concurrency",
    "3",
    "--repo-cache",
    "/tmp/cache",
    "--baseline-bin",
    "/tmp/baseline-opencode",
    "--fork-bin",
    "/tmp/fork-opencode",
    "--out",
    "/tmp/results.json",
  ])
})

it("batchSize 零或负数 抛 EvalArgError", () => {
  expect(() => parseEvalArgs({ model: "m", batchSize: 0, concurrency: 1 } as Record<string, unknown>)).toThrow(EvalArgError)
  expect(() => parseEvalArgs({ model: "m", batchSize: -1, concurrency: 1 } as Record<string, unknown>)).toThrow(EvalArgError)
})

it("concurrency 零或负数 抛 EvalArgError", () => {
  expect(() => parseEvalArgs({ model: "m", batchSize: 5, concurrency: 0 } as Record<string, unknown>)).toThrow(EvalArgError)
})

it("resume 字段 解析后透传到 driver invocation", () => {
  const args = parseEvalArgs({
    model: "m",
    resume: "2026-08-01-run",
  } as Record<string, unknown>)
  expect(args.resume).toBe("2026-08-01-run")
})

it("dryRun 默认 false, 设为 true 后透传", () => {
  const a1 = parseEvalArgs({ model: "m" } as Record<string, unknown>)
  expect(a1.dryRun).toBe(false)
  const a2 = parseEvalArgs({ model: "m", dryRun: true } as Record<string, unknown>)
  expect(a2.dryRun).toBe(true)
})

it("forkCommit 但 forkBin 缺失且无 OPENCODE_FORK_BIN 环境变量 → invocation leaves Python to fail closed", () => {
  const args = parseEvalArgs({
    model: "m",
    forkCommit: "abc",
    forkBin: "",
  } as Record<string, unknown>)
  const invocation = buildEvalDriverInvocation(args, "/home/huyongjun/openpartner/opencode/packages/opencode")
  expect(invocation.cmd).toContain("--fork-commit")
  expect(invocation.cmd).not.toContain("--fork-bin")
})

it("forkCommit + OPENCODE_FORK_BIN 环境变量 → invocation forwards env without rejecting", () => {
  const previous = process.env.OPENCODE_FORK_BIN
  process.env.OPENCODE_FORK_BIN = "/tmp/env-fork-opencode"
  try {
    const args = parseEvalArgs({
      model: "m",
      forkCommit: "abc",
      forkBin: "",
    } as Record<string, unknown>)
    const invocation = buildEvalDriverInvocation(args, "/home/huyongjun/openpartner/opencode/packages/opencode")
    expect(invocation.env.OPENCODE_FORK_BIN).toBe("/tmp/env-fork-opencode")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_FORK_BIN
    else process.env.OPENCODE_FORK_BIN = previous
  }
})

it("resume 透传到 driver invocation 命令行", () => {
  const args = parseEvalArgs({
    model: "tjg/glm-5.2",
    instancesRange: "0-4",
    forkCommit: "fork123",
    forkBin: "/tmp/fork-opencode",
    baselineBin: "/tmp/baseline-opencode",
    batchSize: 5,
    concurrency: 1,
    repoCache: "/tmp/cache",
    out: "/tmp/results.json",
    resume: "2026-08-01-run",
  } as Record<string, unknown>)
  const invocation = buildEvalDriverInvocation(args, "/home/huyongjun/openpartner/opencode/packages/opencode")
  const resumeIdx = invocation.cmd.indexOf("--resume")
  expect(resumeIdx).toBeGreaterThanOrEqual(0)
  expect(invocation.cmd[resumeIdx + 1]).toBe("2026-08-01-run")
})

it("dryRun 透传到 driver invocation 命令行", () => {
  const args = parseEvalArgs({
    model: "tjg/glm-5.2",
    instancesRange: "0-4",
    forkCommit: "fork123",
    forkBin: "/tmp/fork-opencode",
    baselineBin: "/tmp/baseline-opencode",
    batchSize: 5,
    concurrency: 1,
    repoCache: "/tmp/cache",
    out: "/tmp/results.json",
    dryRun: true,
  } as Record<string, unknown>)
  const invocation = buildEvalDriverInvocation(args, "/home/huyongjun/openpartner/opencode/packages/opencode")
  expect(invocation.cmd).toContain("--dry-run")
})

it("locked baseline commit 不被 forkCommit 覆盖", () => {
  expect(BASELINE_COMMIT_LOCK).toBe("f7204902192624481e526b1852cdedaadb914e24")
  const args = parseEvalArgs({
    model: "m",
    forkCommit: BASELINE_COMMIT_LOCK,
  } as Record<string, unknown>)
  expect(args.baselineCommit).toBe(BASELINE_COMMIT_LOCK)
})
