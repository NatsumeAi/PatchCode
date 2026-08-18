import { buildSeccompProgram, seccompFileName } from "../src/sandbox/linux-seccomp"
import { writeFileSync } from "node:fs"
import path from "node:path"

const dir = path.resolve(import.meta.dir, "../src/sandbox")
for (const arch of ["x64", "arm64"] as const) {
  const bytes = buildSeccompProgram(arch)
  const file = path.join(dir, seccompFileName(arch))
  writeFileSync(file, bytes)
  console.log(`wrote ${file} (${bytes.length} bytes)`)
}
