export * as WorktreeProbe from "./probe"

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type BackendName = "git" | "overlay" | "btrfs" | "reflink"

const run = (cmd: string, args: string[]) => {
  try {
    return spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 }) // sandbox:host
  } catch {
    return { status: 1, stdout: "", stderr: "" }
  }
}

/** Last faster backend seen by probe (for logs). Acquire still uses git. */
export let detectedFaster: Exclude<BackendName, "git"> | undefined

export function probe(): BackendName {
  detectedFaster = undefined
  const fstype = run("findmnt", ["-n", "-o", "FSTYPE", "/"]).stdout.trim().toLowerCase()
  if (fstype.includes("btrfs")) detectedFaster = "btrfs"
  else if (fstype.includes("overlay")) detectedFaster = "overlay"

  const tmp = path.join(os.tmpdir(), `oc-wt-probe-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(tmp, { recursive: true })
    const src = path.join(tmp, "a")
    const dst = path.join(tmp, "b")
    fs.writeFileSync(src, "x")
    const reflink = run("cp", ["--reflink=always", src, dst])
    if (reflink.status === 0 && !detectedFaster) detectedFaster = "reflink"
  } catch {
    // ignore
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  // This PR always reports git as the selectable backend. Faster hits are
  // recorded on detectedFaster so acquire can log worktree.backend_unavailable.
  return "git"
}
