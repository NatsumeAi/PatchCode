export * as LinuxBwrap from "./linux-bwrap"

import fs from "node:fs"
import type { ResolvedProfile } from "./profile"

export type SpawnClass = "workspace-child" | "integration-child"

export interface ExtraBind {
  readonly from: string
  readonly to: string
  readonly ro?: boolean
}

export interface LinuxWrapInput {
  readonly profile: ResolvedProfile
  readonly class: SpawnClass
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
  readonly bwrapPath: string
  readonly deniedFiles: readonly string[]
  readonly deniedDirs: readonly string[]
  readonly seccompFd?: number
  readonly extraBinds?: readonly ExtraBind[]
}

export interface WrappedArgv {
  readonly command: string
  readonly args: string[]
}

export function buildLinuxWrap(input: LinuxWrapInput): WrappedArgv {
  const args: string[] = ["--die-with-parent", "--unshare-pid", "--dev", "/dev", "--proc", "/proc"]
  const unshareNet = input.class === "workspace-child" && input.profile.restrictNetwork
  if (unshareNet) args.push("--unshare-net")

  if (input.profile.name === "strict" || !input.profile.defaultRead) {
    for (const root of input.profile.readRoots) {
      // --dev/--proc already own these mounts; a second ro-bind makes bwrap exit 1.
      if (root === "/dev" || root === "/proc") continue
      if (!fs.existsSync(root)) continue
      args.push("--ro-bind", root, root)
    }
    // Fresh /tmp, then writable binds so Global.Path.tmp under /tmp stays reachable.
    args.push("--tmpfs", "/tmp")
  } else {
    args.push("--ro-bind", "/", "/")
  }

  for (const root of input.profile.writeRoots) {
    if (!fs.existsSync(root)) continue
    args.push("--bind", root, root)
  }
  for (const file of input.deniedFiles) {
    args.push("--ro-bind", "/dev/null", file)
  }
  for (const dir of input.deniedDirs) {
    args.push("--tmpfs", dir)
  }
  for (const bind of input.extraBinds ?? []) {
    args.push(bind.ro === false ? "--bind" : "--ro-bind", bind.from, bind.to)
  }
  if (input.seccompFd !== undefined) {
    args.push("--seccomp", String(input.seccompFd))
  }
  args.push("--chdir", input.cwd, "--", input.command, ...input.args)
  return { command: input.bwrapPath, args }
}
