export * as PromptTapeStore from "./prompt-tape-store"

import type { PromptTape } from "./prompt-tape"
import type { ToolRegistry } from "../../tool/registry"

const tapes = new Map<string, PromptTape.Tape>()
const settles = new Map<string, ToolRegistry.Materialization["settle"]>()
const lastSeqs = new Map<string, number>()

export const key = (sessionID: string, baselineSeq: number) => `${sessionID}:${baselineSeq}`

export const get = (sessionID: string, baselineSeq: number) => tapes.get(key(sessionID, baselineSeq))

export const set = (sessionID: string, baselineSeq: number, tape: PromptTape.Tape) => {
  tapes.set(key(sessionID, baselineSeq), tape)
}

export const getSettle = (sessionID: string, baselineSeq: number) => settles.get(key(sessionID, baselineSeq))

export const setSettle = (sessionID: string, baselineSeq: number, settle: ToolRegistry.Materialization["settle"]) => {
  settles.set(key(sessionID, baselineSeq), settle)
}

export const getLastSeq = (sessionID: string, baselineSeq: number) => lastSeqs.get(key(sessionID, baselineSeq)) ?? 0

export const setLastSeq = (sessionID: string, baselineSeq: number, seq: number) => {
  lastSeqs.set(key(sessionID, baselineSeq), seq)
}

/** Delete every epoch for this session id, plus an exact full-key match if present. */
export const clear = (sessionID: string) => {
  tapes.delete(sessionID)
  settles.delete(sessionID)
  lastSeqs.delete(sessionID)
  const prefix = `${sessionID}:`
  for (const item of [...tapes.keys()]) if (item.startsWith(prefix)) tapes.delete(item)
  for (const item of [...settles.keys()]) if (item.startsWith(prefix)) settles.delete(item)
  for (const item of [...lastSeqs.keys()]) if (item.startsWith(prefix)) lastSeqs.delete(item)
}

export const clearAll = () => {
  tapes.clear()
  settles.clear()
  lastSeqs.clear()
}
