import { describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const packagesRoot = path.resolve(import.meta.dir, "../..")
const applyPatch = path.resolve(import.meta.dir, "../src/tool/apply-patch.ts")
const editMatch = path.normalize(path.resolve(import.meta.dir, "../src/tool/edit-match.ts"))
const levenshteinDecl = ["function", "levenshtein"].join(" ")
const unsupportedMoves = ["moves are not", "supported yet"].join(" ")

async function walkTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walkTs(next)))
    else if (entry.name.endsWith(".ts")) files.push(next)
  }
  return files
}

describe("edit-match inventory", () => {
  test("levenshtein helper is defined in a single core module", async () => {
    const hits: string[] = []
    for (const file of await walkTs(packagesRoot)) {
      const text = await readFile(file, "utf8")
      if (text.includes(levenshteinDecl)) hits.push(path.relative(packagesRoot, file))
    }
    expect(hits).toEqual([path.relative(packagesRoot, editMatch)])
  })

  test("apply-patch no longer rejects moves as unsupported", async () => {
    const info = await stat(applyPatch)
    expect(info.isFile()).toBe(true)
    const text = await readFile(applyPatch, "utf8")
    expect(text.toLowerCase()).not.toContain(unsupportedMoves)
  })
})
