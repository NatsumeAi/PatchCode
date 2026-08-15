export * as PromptTapeStore from "./prompt-tape-store"

import type { PromptTape } from "./prompt-tape"
import { truncate } from "./prompt-tape"
import type { ToolRegistry } from "../../tool/registry"

type RevertSnap = {
  readonly key: string
  readonly tape: PromptTape.Tape
  readonly lastSeq: number
  readonly seqs: ReadonlyArray<number>
  readonly recall: string
}

const tapes = new Map<string, PromptTape.Tape>()
const settles = new Map<string, ToolRegistry.Materialization["settle"]>()
const lastSeqs = new Map<string, number>()
const messageSeqs = new Map<string, number[]>()
const recalls = new Map<string, string>()
const revertSnaps = new Map<string, ReadonlyArray<RevertSnap>>()

export const key = (sessionID: string, baselineSeq: number) => `${sessionID}:${baselineSeq}`

const matchesSession = (sessionID: string, item: string) => item === sessionID || item.startsWith(`${sessionID}:`)

const baselineSeqOf = (item: string) => {
  const index = item.lastIndexOf(":")
  return index === -1 ? undefined : Number(item.slice(index + 1))
}

const deleteSessionKeys = (sessionID: string, map: Map<string, unknown>) => {
  map.delete(sessionID)
  const prefix = `${sessionID}:`
  for (const item of [...map.keys()]) if (item.startsWith(prefix)) map.delete(item)
}

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

export const getMessageSeqs = (sessionID: string, baselineSeq: number) =>
  messageSeqs.get(key(sessionID, baselineSeq)) ?? []

export const setMessageSeqs = (sessionID: string, baselineSeq: number, seqs: ReadonlyArray<number>) => {
  messageSeqs.set(key(sessionID, baselineSeq), [...seqs])
}

export const appendMessageSeqs = (sessionID: string, baselineSeq: number, added: ReadonlyArray<number>) => {
  setMessageSeqs(sessionID, baselineSeq, [...getMessageSeqs(sessionID, baselineSeq), ...added])
}

export const getRecall = (sessionID: string, baselineSeq: number) => recalls.get(key(sessionID, baselineSeq))

export const setRecall = (sessionID: string, baselineSeq: number, recall: string) => {
  recalls.set(key(sessionID, baselineSeq), recall)
}

export const epochs = (sessionID: string) => {
  const out: Array<{ baselineSeq: number; tape: PromptTape.Tape }> = []
  for (const [item, tape] of tapes) {
    if (!matchesSession(sessionID, item)) continue
    const baselineSeq = baselineSeqOf(item)
    if (baselineSeq === undefined || Number.isNaN(baselineSeq)) continue
    out.push({ baselineSeq, tape })
  }
  return out
}

export const snapshotRevert = (sessionID: string) => {
  const snaps: RevertSnap[] = []
  for (const [item, tape] of tapes) {
    if (!matchesSession(sessionID, item)) continue
    snaps.push({
      key: item,
      tape,
      lastSeq: lastSeqs.get(item) ?? 0,
      seqs: messageSeqs.get(item) ?? [],
      recall: recalls.get(item) ?? "",
    })
  }
  revertSnaps.set(sessionID, snaps)
}

export const restoreRevert = (sessionID: string) => {
  const snaps = revertSnaps.get(sessionID)
  if (!snaps) return false
  clear(sessionID)
  for (const snap of snaps) {
    tapes.set(snap.key, snap.tape)
    lastSeqs.set(snap.key, snap.lastSeq)
    messageSeqs.set(snap.key, [...snap.seqs])
    recalls.set(snap.key, snap.recall)
  }
  revertSnaps.delete(sessionID)
  return true
}

/** Keep Chat messages whose session seq is still at or before the revert boundary. */
export const truncateToSeq = (sessionID: string, seq: number) => {
  for (const [item, tape] of [...tapes]) {
    if (!matchesSession(sessionID, item)) continue
    const seqs = messageSeqs.get(item) ?? []
    if (seqs.length !== tape.messages.length) {
      tapes.delete(item)
      lastSeqs.delete(item)
      messageSeqs.delete(item)
      recalls.delete(item)
      settles.delete(item)
      continue
    }
    const keep = seqs.filter((value) => value <= seq).length
    tapes.set(item, truncate(tape, keep))
    messageSeqs.set(item, seqs.slice(0, keep))
    lastSeqs.set(item, Math.min(lastSeqs.get(item) ?? 0, seq))
  }
  revertSnaps.delete(sessionID)
}

/** Delete every epoch for this session id, plus an exact full-key match if present. */
export const clear = (sessionID: string) => {
  deleteSessionKeys(sessionID, tapes)
  deleteSessionKeys(sessionID, settles)
  deleteSessionKeys(sessionID, lastSeqs)
  deleteSessionKeys(sessionID, messageSeqs)
  deleteSessionKeys(sessionID, recalls)
  revertSnaps.delete(sessionID)
}

export const clearAll = () => {
  tapes.clear()
  settles.clear()
  lastSeqs.clear()
  messageSeqs.clear()
  recalls.clear()
  revertSnaps.clear()
}
