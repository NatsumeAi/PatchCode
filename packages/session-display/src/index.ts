// Core types
export type {
  DisplayMode,
  PartStatus,
  ToolFamily,
  DisplayPolicy,
  ResolveModeInput,
  HeaderModel,
  BodyModel,
  ToolViewModel,
  FoldCycle,
} from "./mode"
export { resolveMode, chromeFor } from "./mode"

// Fold
export { nextFoldMode } from "./fold"

// Verb-group
export type { VerbGroupKind, VerbRun, VerbRunMemberInput } from "./verb-group"
export {
  buildGroupedItems,
  classifyVerbRuns,
  eagerFoldKind,
  nounLabel,
  verbGroupHeaderLabel,
  verbLabel,
} from "./verb-group"

// Config
export type { DisplayConfig } from "./config"
export { DEFAULT_CONFIG, mergeConfig } from "./config"

// Normalize
export { normalizeToolName } from "./normalize"

// Header utilities
export { shortenPath, truncateText, formatDuration, filename, toEpochMs } from "./header-utils"

// Registry
export type { DisplayContext, ToolDescriptor } from "./registry"
export { registerDescriptor, getDescriptor, listDescriptors } from "./registry"

// Build
export { buildToolViewModel } from "./build"

// Reasoning
export type { ReasoningViewModel } from "./parts/reasoning"
export {
  REASONING_HOLD_OPEN_MS,
  applyReasoningHoldOpen,
  buildReasoningViewModel,
  reasoningSummary,
  resolveReasoningMode,
  shouldHoldReasoningOpen,
} from "./parts/reasoning"

// Descriptors (side-effect: registers all)
export { readDescriptor } from "./tools/read"
export { globDescriptor } from "./tools/glob"
export { grepDescriptor } from "./tools/grep"
export { webfetchDescriptor, websearchDescriptor } from "./tools/web"
export { shellDescriptor } from "./tools/shell"
export { editDescriptor } from "./tools/edit"
export { writeDescriptor } from "./tools/write"
export { patchDescriptor } from "./tools/patch"
export { taskDescriptor } from "./tools/task"
export { todoDescriptor } from "./tools/todo"
export { questionDescriptor } from "./tools/question"
export { skillDescriptor } from "./tools/skill"
export { genericDescriptor } from "./tools/generic"

// Register all descriptors on import
import { registerDescriptor } from "./registry"
import { readDescriptor } from "./tools/read"
import { globDescriptor } from "./tools/glob"
import { grepDescriptor } from "./tools/grep"
import { webfetchDescriptor, websearchDescriptor } from "./tools/web"
import { shellDescriptor } from "./tools/shell"
import { editDescriptor } from "./tools/edit"
import { writeDescriptor } from "./tools/write"
import { patchDescriptor } from "./tools/patch"
import { taskDescriptor } from "./tools/task"
import { todoDescriptor } from "./tools/todo"
import { questionDescriptor } from "./tools/question"
import { skillDescriptor } from "./tools/skill"

registerDescriptor(readDescriptor)
registerDescriptor(globDescriptor)
registerDescriptor(grepDescriptor)
registerDescriptor(webfetchDescriptor)
registerDescriptor(websearchDescriptor)
registerDescriptor(shellDescriptor)
registerDescriptor(editDescriptor)
registerDescriptor(writeDescriptor)
registerDescriptor(patchDescriptor)
registerDescriptor(taskDescriptor)
registerDescriptor(todoDescriptor)
registerDescriptor(questionDescriptor)
registerDescriptor(skillDescriptor)
