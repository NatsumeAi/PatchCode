export * as PersonaFingerprint from "./fingerprint"

import { createHash } from "node:crypto"

/** Stable fingerprint of resolved persona instructions for resume drift detection. */
export function fingerprintInstructions(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex").slice(0, 16)
}
