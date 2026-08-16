import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

describe.skipIf(process.platform === "win32")("killpg leftover", () => {
  test("killpg + wait reaps a new-session sleep", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    const pid = child.pid
    expect(pid).toBeGreaterThan(0)
    await Bun.sleep(50)
    process.kill(-pid!, "SIGKILL")
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c))
      setTimeout(() => resolve(child.exitCode), 2000)
    })
    expect(code === null || code !== 0).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  })
})
