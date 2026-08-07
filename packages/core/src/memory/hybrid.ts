export const DEFAULT_VECTOR_WEIGHT = 0.7
export const DEFAULT_TEXT_WEIGHT = 0.3
export const DEFAULT_MIN_SCORE = 0.35

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0)
    na += a[i]! ** 2
    nb += (b[i] ?? 0) ** 2
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function normalize01(values: ReadonlyArray<number>): ReadonlyArray<number> {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return values.map(() => 1)
  return values.map((value) => (value - min) / (max - min))
}

export function hybridScore(vector: number, text: number, vectorWeight = DEFAULT_VECTOR_WEIGHT): number {
  return vectorWeight * vector + (1 - vectorWeight) * text
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const token of a) if (b.has(token)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Greedy MMR with Jaccard token similarity: diversity re-ranking. */
export function applyMmr(
  items: ReadonlyArray<{ id: string; score: number; text: string }>,
  lambda: number,
  topN: number,
): Array<{ id: string; score: number; text: string }> {
  const selected: Array<{ id: string; score: number; text: string }> = []
  const pool = [...items]
  while (selected.length < topN && pool.length > 0) {
    let bestIndex = 0
    let bestValue = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!
      const maxSim = selected.reduce((max, sel) => Math.max(max, jaccard(tokens(item.text), tokens(sel.text))), 0)
      const value = lambda * item.score - (1 - lambda) * maxSim
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!)
  }
  return selected
}
