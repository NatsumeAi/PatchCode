export * as SkillLock from "./lock"

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Global } from "../global"

export type State = "quarantine" | "active"

export type Row = {
  readonly name: string
  readonly source: "url" | "github" | "dir"
  readonly uri: string
  readonly sha256: string
  readonly installedAt: number
  readonly state: State
}

export type File = {
  skills: Row[]
}

export const fileName = "skills-lock.json"

export const lockPath = (configDir?: string) => path.join(configDir ?? Global.Path.config, fileName)

export const skillsDir = (configDir?: string) => path.join(configDir ?? Global.Path.config, "skills")

export const hashText = (text: string) => createHash("sha256").update(text).digest("hex")

const empty = (): File => ({ skills: [] })

export const read = async (configDir?: string): Promise<File> => {
  const file = lockPath(configDir)
  try {
    const raw = await fs.readFile(file, "utf8")
    if (!raw.trim()) return empty()
    const parsed = JSON.parse(raw) as File
    if (!parsed || !Array.isArray(parsed.skills)) return empty()
    return {
      skills: parsed.skills.filter(
        (row): row is Row =>
          !!row &&
          typeof row.name === "string" &&
          typeof row.uri === "string" &&
          typeof row.sha256 === "string" &&
          (row.state === "quarantine" || row.state === "active"),
      ),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw error
  }
}

export const write = async (file: File, configDir?: string) => {
  const target = lockPath(configDir)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify({ skills: file.skills }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, target)
}

export const upsert = async (row: Row, configDir?: string) => {
  const current = await read(configDir)
  const next = current.skills.filter((item) => item.name !== row.name)
  next.push(row)
  next.sort((a, b) => a.name.localeCompare(b.name))
  await write({ skills: next }, configDir)
  return row
}

export const get = async (name: string, configDir?: string) => {
  const current = await read(configDir)
  return current.skills.find((row) => row.name === name)
}

export const quarantinedNames = async (configDir?: string) => {
  const current = await read(configDir)
  return new Set(current.skills.filter((row) => row.state === "quarantine").map((row) => row.name))
}
