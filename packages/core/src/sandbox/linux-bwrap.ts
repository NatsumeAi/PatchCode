export * as LinuxBwrap from "./linux-bwrap"

import type { ResolvedProfile } from "./profile"

export type SpawnClass = "workspace-child" | "integration-child"

export interface LinuxWrapInput {
  readonly profile: ResolvedProfile
  readonly class: SpawnClass
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
  readonly bwrapPath: string
  readonly deniedFiles: readonly string[]
  readonly deniedDirs: readonly string[]
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
      args.push("--ro-bind", root, root)
    }
    // Fresh /tmp, then writable binds so Global.Path.tmp under /tmp stays reachable.
    args.push("--tmpfs", "/tmp")
  } else {
    args.push("--ro-bind", "/", "/")
  }

  for (const root of input.profile.writeRoots) {
    args.push("--bind", root, root)
  }
  for (const file of input.deniedFiles) {
    args.push("--ro-bind", "/dev/null", file)
  }
  for (const dir of input.deniedDirs) {
    args.push("--tmpfs", dir)
  }
  args.push("--chdir", input.cwd, "--", input.command, ...input.args)
  return { command: input.bwrapPath, args }
}
