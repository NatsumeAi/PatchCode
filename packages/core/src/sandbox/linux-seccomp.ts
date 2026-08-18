export * as LinuxSeccomp from "./linux-seccomp"

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BPF_LD = 0x00
const BPF_W = 0x00
const BPF_ABS = 0x20
const BPF_JMP = 0x05
const BPF_JEQ = 0x10
const BPF_K = 0x00
const BPF_RET = 0x06

const LD_ABS_W = BPF_LD | BPF_W | BPF_ABS
const JMP_JEQ_K = BPF_JMP | BPF_JEQ | BPF_K
const RET_K = BPF_RET | BPF_K

const SECCOMP_RET_ALLOW = 0x7fff0000
const SECCOMP_RET_ERRNO = 0x00050000
const EPERM = 1

const AUDIT_ARCH_X86_64 = 0xc000003e
const AUDIT_ARCH_AARCH64 = 0xc00000b7

const TIOCSTI = 0x5412
const TIOCLINUX = 0x541c

/** Offsets in struct seccomp_data. */
const OFF_NR = 0
const OFF_ARCH = 4
const OFF_ARGS1 = 24

export const SECCOMP_FD = 3

type Arch = "x64" | "arm64"

const SYSCALLS: Record<Arch, { ioctl: number; denied: readonly number[] }> = {
  x64: {
    ioctl: 16,
    denied: [
      101, // ptrace
      103, // syslog
      155, // pivot_root
      163, // acct
      165, // mount
      166, // umount2
      167, // swapon
      168, // swapoff
      169, // reboot
      172, // iopl
      173, // ioperm
      175, // init_module
      176, // delete_module
      246, // kexec_load
      248, // add_key
      249, // request_key
      250, // keyctl
      298, // perf_event_open
      304, // open_by_handle_at
      308, // setns
      310, // process_vm_readv
      311, // process_vm_writev
      313, // finit_module
      320, // kexec_file_load
      321, // bpf
      323, // userfaultfd
      425, // io_uring_setup
      426, // io_uring_enter
      427, // io_uring_register
      428, // open_tree
      429, // move_mount
      430, // fsopen
      431, // fsconfig
      432, // fsmount
      442, // mount_setattr
    ],
  },
  arm64: {
    ioctl: 29,
    denied: [
      26, // ptrace
      39, // umount2
      40, // mount
      104, // kexec_load
      105, // init_module
      106, // delete_module
      116, // syslog
      142, // reboot
      165, // setns
      216, // acct
      224, // swapon
      225, // swapoff
      241, // perf_event_open
      264, // open_by_handle_at
      270, // process_vm_readv
      271, // process_vm_writev
      273, // finit_module
      280, // bpf
      282, // userfaultfd
      294, // kexec_file_load
      425, 426, 427, 428, 429, 430, 431, 432, 442,
    ],
  },
}

type Insn = { code: number; jt: number; jf: number; k: number }

function encode(insns: readonly Insn[]): Uint8Array {
  const out = Buffer.alloc(insns.length * 8)
  for (let i = 0; i < insns.length; i++) {
    const insn = insns[i]!
    const o = i * 8
    out.writeUInt16LE(insn.code, o)
    out.writeUInt8(insn.jt, o + 2)
    out.writeUInt8(insn.jf, o + 3)
    out.writeUInt32LE(insn.k >>> 0, o + 4)
  }
  return new Uint8Array(out)
}

export function buildSeccompProgram(arch: Arch): Uint8Array {
  const spec = SYSCALLS[arch]
  const audit = arch === "arm64" ? AUDIT_ARCH_AARCH64 : AUDIT_ARCH_X86_64
  const insns: Insn[] = []
  const push = (insn: Insn) => insns.push(insn)

  push({ code: LD_ABS_W, jt: 0, jf: 0, k: OFF_ARCH })
  const jeqArch = insns.length
  push({ code: JMP_JEQ_K, jt: 0, jf: 0, k: audit })
  push({ code: LD_ABS_W, jt: 0, jf: 0, k: OFF_NR })
  const jeqSys: number[] = []
  for (const nr of spec.denied) {
    jeqSys.push(insns.length)
    push({ code: JMP_JEQ_K, jt: 0, jf: 0, k: nr })
  }
  const jeqIoctl = insns.length
  push({ code: JMP_JEQ_K, jt: 0, jf: 0, k: spec.ioctl })
  const allow = insns.length
  push({ code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW })
  push({ code: LD_ABS_W, jt: 0, jf: 0, k: OFF_ARGS1 })
  const jeqTiocsti = insns.length
  push({ code: JMP_JEQ_K, jt: 0, jf: 0, k: TIOCSTI })
  const jeqTioclinux = insns.length
  push({ code: JMP_JEQ_K, jt: 0, jf: 0, k: TIOCLINUX })
  const allowIoctl = insns.length
  push({ code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW })
  const kill = insns.length
  push({ code: RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO | EPERM })

  const skip = (from: number, to: number) => to - from - 1
  insns[jeqArch]!.jf = skip(jeqArch, kill)
  for (const i of jeqSys) {
    insns[i]!.jt = skip(i, kill)
  }
  // ioctl: equal → skip ALLOW, fall into args check; not equal → ALLOW
  insns[jeqIoctl]!.jt = skip(jeqIoctl, allow + 1)
  insns[jeqIoctl]!.jf = skip(jeqIoctl, allow)
  insns[jeqTiocsti]!.jt = skip(jeqTiocsti, kill)
  insns[jeqTioclinux]!.jt = skip(jeqTioclinux, kill)
  insns[jeqTioclinux]!.jf = skip(jeqTioclinux, allowIoctl)
  return encode(insns)
}

export function currentSeccompArch(): Arch {
  return process.arch === "arm64" ? "arm64" : "x64"
}

export function seccompFileName(arch: Arch = currentSeccompArch()) {
  return arch === "arm64" ? "linux-seccomp-arm64.bpf" : "linux-seccomp-x64.bpf"
}

const here = path.dirname(fileURLToPath(import.meta.url))

export function seccompBpfPath(arch: Arch = currentSeccompArch()) {
  return path.join(here, seccompFileName(arch))
}

export function loadSeccompBpf(arch: Arch = currentSeccompArch()): Uint8Array | undefined {
  const file = seccompBpfPath(arch)
  try {
    return new Uint8Array(fs.readFileSync(file))
  } catch {
    return undefined
  }
}
