import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DREAM_HOURS,
  DEFAULT_DREAM_POLICY,
  DEFAULT_RECOVERY_THRESHOLD,
  filterSourcesForPhase,
  selectDuePhase,
  shouldRecover,
  type DreamPhase,
} from "../../src/memory/dream-phases"
import type { MergeSource } from "../../src/memory/sources"

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

const deepPolicy = { ...DEFAULT_DREAM_POLICY, phase: "deep" as DreamPhase }

const hours = { light: 6, deep: 24, rem: 168 }

function makeSource(
  kind: MergeSource["kind"],
  overrides: Partial<MergeSource> & { accessCount?: number } = {},
) {
  const id = overrides.id ?? `${kind.slice(0, 3)}:${kind}-${Math.random()}`
  const mtime = overrides.mtime ?? Date.now()
  return {
    kind,
    id,
    relativePath: `${kind}s/${id}.md`,
    absolutePath: `/mem/${kind}s/${id}.md`,
    text: `text of ${id}`,
    mtime,
    ...overrides,
  }
}

describe("dream phase defaults", () => {
  test("hours match openclaw alignment: light 6h, deep 24h, rem 168h", () => {
    expect(DEFAULT_DREAM_HOURS).toEqual({ light: 6, deep: 24, rem: 168 })
  })

  test("policy defaults: minAccess 3, 14d half-life, minScore 0.8, dedupe 0.9", () => {
    expect(DEFAULT_DREAM_POLICY).toMatchObject({
      phase: "deep",
      minAccess: 3,
      recencyHalfLifeDays: 14,
      minScore: 0.8,
      dedupeThreshold: 0.9,
    })
  })

  test("recovery threshold is 0.35", () => {
    expect(DEFAULT_RECOVERY_THRESHOLD).toBe(0.35)
  })
})

describe("selectDuePhase", () => {
  const now = 1_000_000_000_000

  test("never-run phases are immediately due, light first", () => {
    expect(selectDuePhase(now, {}, hours)).toBe("light")
    expect(selectDuePhase(now, { light: now }, hours)).toBe("deep")
    expect(selectDuePhase(now, { light: now, deep: now }, hours)).toBe("rem")
  })

  test("due exactly at the hour threshold (inclusive)", () => {
    expect(selectDuePhase(now, { light: now - 6 * HOUR_MS }, hours)).toBe("light")
    expect(selectDuePhase(now, { light: now, deep: now - 24 * HOUR_MS }, hours)).toBe("deep")
    expect(
      selectDuePhase(now, { light: now, deep: now, rem: now - 168 * HOUR_MS }, hours),
    ).toBe("rem")
  })

  test("just under the threshold is not due", () => {
    expect(
      selectDuePhase(now, { light: now - 6 * HOUR_MS + 1, deep: now, rem: now }, hours),
    ).toBeUndefined()
    expect(
      selectDuePhase(now, { light: now, deep: now - 24 * HOUR_MS + 1, rem: now }, hours),
    ).toBeUndefined()
    expect(
      selectDuePhase(now, { light: now, deep: now, rem: now - 168 * HOUR_MS + 1 }, hours),
    ).toBeUndefined()
  })

  test("overdue is due", () => {
    expect(selectDuePhase(now, { light: now - 7 * HOUR_MS }, hours)).toBe("light")
  })

  test("priority: light wins when multiple are due", () => {
    expect(
      selectDuePhase(now, { light: now - 10 * HOUR_MS, deep: now - 48 * HOUR_MS }, hours),
    ).toBe("light")
    expect(
      selectDuePhase(now, { light: now, deep: now - 48 * HOUR_MS, rem: now - 200 * HOUR_MS }, hours),
    ).toBe("deep")
  })

  test("all recent: nothing due", () => {
    expect(selectDuePhase(now, { light: now - 1, deep: now - 1, rem: now - 1 }, hours)).toBeUndefined()
  })

  test("hours are per-phase, not shared", () => {
    const custom = { light: 1, deep: 1, rem: 1 }
    expect(selectDuePhase(now, { light: now - HOUR_MS }, custom)).toBe("light")
    expect(selectDuePhase(now, { light: now, deep: now - HOUR_MS }, custom)).toBe("deep")
  })
})

describe("filterSourcesForPhase", () => {
  const recent = Date.now()
  const recentSession = makeSource("session", { id: "recent", mtime: recent, accessCount: 1 })
  const coldSession = makeSource("session", {
    id: "cold",
    mtime: recent - 30 * DAY_MS,
    accessCount: 5,
  })
  const oldNote = makeSource("note", { id: "old-note", mtime: recent - 365 * DAY_MS })
  const freshNote = makeSource("note", { id: "fresh-note", mtime: recent })
  const candidate = makeSource("candidate", { id: "cand", mtime: recent, accessCount: 2 })

  test("clock injection: same input, different now, different result", () => {
    const fiveDaysOld = makeSource("session", {
      id: "five-days",
      mtime: recent - 5 * DAY_MS,
      accessCount: 5,
    })
    expect(filterSourcesForPhase([fiveDaysOld], "light", deepPolicy, recent)).toHaveLength(1)
    expect(filterSourcesForPhase([fiveDaysOld], "light", deepPolicy, recent + 10 * DAY_MS)).toHaveLength(0)
  })

  test("light: all notes and candidates included regardless of age", () => {
    const result = filterSourcesForPhase([coldSession, oldNote, candidate, recentSession], "light", deepPolicy, recent)
    expect(result.map((s) => s.id).sort()).toEqual(["cand", "old-note", "recent"])
  })

  test("light: recent session included, cold session dropped", () => {
    const result = filterSourcesForPhase([coldSession, recentSession], "light", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["recent"])
  })

  test("light: session with uncomputable mtime is kept (fail open)", () => {
    const neverStatted = makeSource("session", { id: "nofstat", mtime: 0 })
    const result = filterSourcesForPhase([neverStatted], "light", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["nofstat"])
  })

  test("deep: notes always eligible even when old or low-access", () => {
    const lowAccessNote = makeSource("note", { id: "low-note", mtime: recent - 400 * DAY_MS, accessCount: 0 })
    const result = filterSourcesForPhase([lowAccessNote, coldSession], "deep", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["low-note"])
  })

  test("deep: low-access session dropped even when recent", () => {
    const result = filterSourcesForPhase([recentSession], "deep", deepPolicy, recent)
    expect(result).toEqual([])
  })

  test("deep: high-access recent session kept", () => {
    const hot = makeSource("session", { id: "hot", mtime: recent, accessCount: 5 })
    const result = filterSourcesForPhase([hot], "deep", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["hot"])
  })

  test("deep: high-access but cold session dropped (recency gate)", () => {
    const result = filterSourcesForPhase([coldSession], "deep", deepPolicy, recent)
    expect(result).toEqual([])
  })

  test("deep: missing accessCount metadata is kept (fail open)", () => {
    const noMeta = makeSource("session", { id: "nometa", mtime: recent })
    const result = filterSourcesForPhase([noMeta], "deep", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["nometa"])
  })

  test("deep: non-finite accessCount is kept (fail open)", () => {
    const badMeta = makeSource("session", { id: "badmeta", mtime: recent, accessCount: NaN })
    const result = filterSourcesForPhase([badMeta], "deep", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["badmeta"])
  })

  test("deep: candidate gated like session", () => {
    const result = filterSourcesForPhase([candidate], "deep", deepPolicy, recent)
    expect(result).toEqual([])
    const hotCand = makeSource("candidate", { id: "hotcand", mtime: recent, accessCount: 4 })
    expect(filterSourcesForPhase([hotCand], "deep", deepPolicy, recent).map((s) => s.id)).toEqual(["hotcand"])
  })

  test("deep: boundary accessCount exactly minAccess passes", () => {
    const atBoundary = makeSource("session", { id: "boundary", mtime: recent, accessCount: 3 })
    expect(filterSourcesForPhase([atBoundary], "deep", deepPolicy, recent).map((s) => s.id)).toEqual(["boundary"])
  })

  test("rem: notes always included, high-access sessions kept regardless of age", () => {
    const result = filterSourcesForPhase(
      [coldSession, freshNote, recentSession, candidate],
      "rem",
      deepPolicy,
      recent,
    )
    expect(result.map((s) => s.id).sort()).toEqual(["cold", "fresh-note"].sort())
  })

  test("rem: low-access session dropped but missing metadata kept", () => {
    const noMeta = makeSource("session", { id: "nometa", mtime: recent - 100 * DAY_MS })
    const result = filterSourcesForPhase([recentSession, noMeta], "rem", deepPolicy, recent)
    expect(result.map((s) => s.id)).toEqual(["nometa"])
  })

  test("recovery: forces light selection", () => {
    const result = filterSourcesForPhase(
      [coldSession, oldNote, recentSession],
      "recovery",
      deepPolicy,
      recent,
    )
    expect(result.map((s) => s.id).sort()).toEqual(["old-note", "recent"].sort())
  })

  test("custom minAccess in policy is honored", () => {
    const lax = { ...deepPolicy, minAccess: 2 }
    expect(filterSourcesForPhase([candidate], "deep", lax, recent).map((s) => s.id)).toEqual(["cand"])
    expect(filterSourcesForPhase([recentSession], "deep", lax, recent)).toEqual([])
  })
})

describe("shouldRecover", () => {
  test("health below threshold with short-term sources → recover", () => {
    expect(shouldRecover(0.2, 0.35, 3)).toBe(true)
  })

  test("health at threshold → no recovery", () => {
    expect(shouldRecover(0.35, 0.35, 3)).toBe(false)
  })

  test("health above threshold → no recovery", () => {
    expect(shouldRecover(0.9, 0.35, 3)).toBe(false)
  })

  test("no short-term sources → no recovery even when unhealthy", () => {
    expect(shouldRecover(0.1, 0.35, 0)).toBe(false)
  })

  test("zero health with sources → recovery", () => {
    expect(shouldRecover(0, 0.35, 1)).toBe(true)
  })
})
