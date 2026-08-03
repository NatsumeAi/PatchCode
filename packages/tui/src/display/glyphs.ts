// Simple ASCII chrome — one disclosure family only (`>` closed, `v` open).
// No diamonds / blocks / box-drawing bullets for tool rows.
export const accentBar = " " // rail spacer (no thick bar)
export const collapsedAccent = " "
/** @deprecated use disclosureClosed — kept for imports that still reference diamond */
export const diamondFilled = ">"
export const diamondDotted = ">"
/** Expanded disclosure (points down). */
export const disclosureOpen = "v"
/** Collapsed disclosure (points right). */
export const disclosureClosed = ">"
export const checkMark = "\u2713" // ✓
export const ballotX = "\u2717" // ✗
export const chevron = ">"
export const chevronDown = "v"
export const selectionBar = " "
export const brailleSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const
