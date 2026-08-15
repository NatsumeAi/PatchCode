import type { ChildProcessWithoutNullStreams } from "child_process"
import { wrapSpawn } from "@opencode-ai/core/sandbox"
import { Process } from "@/util/process"

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawnHost(cmd: string, args: string[], opts?: Process.Options): Child
export function spawnHost(cmd: string, opts?: Process.Options): Child
export function spawnHost(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}

export async function spawn(cmd: string, args: string[], opts?: Process.Options): Promise<Child>
export async function spawn(cmd: string, opts?: Process.Options): Promise<Child>
export async function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options): Promise<Child> {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const wrapped = await wrapSpawn({
    class: "integration-child",
    command: cmd,
    args,
    cwd: cfg?.cwd ?? process.cwd(),
    whenUnpinned: "location",
    location: cfg?.cwd,
  })
  return spawnHost(wrapped.command, wrapped.args, cfg)
}
