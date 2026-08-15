export * as Trust from "./trust"

import fs from "fs/promises"
import path from "path"
import { Global } from "./global"

export const FILE_NAME = "trusted-folders.json"

export interface Store {
  folders: string[]
}

export interface Options {
  readonly configDir?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const storePath = (options: Options = {}) =>
  path.join(options.configDir ?? Global.Path.config, FILE_NAME)

const canonical = async (absPath: string) => {
  const resolved = path.resolve(absPath)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

const readStore = async (file: string): Promise<Store> => {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { folders: [] }
    throw error
  }
  if (raw.trim().length === 0) return { folders: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { folders: [] }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.folders)) return { folders: [] }
  return {
    folders: parsed.folders.filter((folder): folder is string => typeof folder === "string" && folder.length > 0),
  }
}

const writeStore = async (file: string, store: Store) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify({ folders: store.folders }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, file)
}

const covers = (trusted: string, candidate: string) => {
  if (trusted === candidate) return true
  const prefix = trusted.endsWith(path.sep) ? trusted : trusted + path.sep
  return candidate.startsWith(prefix)
}

export const list = async (options: Options = {}) => {
  const store = await readStore(storePath(options))
  return [...store.folders]
}

export const isTrusted = async (absPath: string, options: Options = {}) => {
  const candidate = await canonical(absPath)
  const folders = await list(options)
  for (const folder of folders) {
    if (covers(folder, candidate)) return true
  }
  return false
}

export const grant = async (absPath: string, options: Options = {}) => {
  const folder = await canonical(absPath)
  const file = storePath(options)
  const store = await readStore(file)
  if (!store.folders.includes(folder)) store.folders.push(folder)
  store.folders.sort()
  await writeStore(file, store)
  return folder
}

export const revoke = async (absPath: string, options: Options = {}) => {
  const folder = await canonical(absPath)
  const file = storePath(options)
  const store = await readStore(file)
  store.folders = store.folders.filter((entry) => entry !== folder)
  await writeStore(file, store)
}
