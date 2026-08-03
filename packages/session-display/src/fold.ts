import type { DisplayMode } from "./mode"

/**
 * Grok fold state machine (verified `blocks/tool/read.rs` for 3-state,
 * default BlockContent::next_fold_mode for 2-state).
 * "three": Collapsed→Truncated→Collapsed (read keeps a mid-density preview).
 * "two": Collapsed→Expanded→Collapsed.
 * Note: Grok ignores the running flag for read (parameter `_is_running`),
 * so the cycle is state-independent.
 */
export function nextFoldMode(cycle: FoldCycle, current: DisplayMode, _isRunning: boolean): DisplayMode {
  if (cycle === "three") {
    if (current === "collapsed") return "truncated"
    return "collapsed"
  }
  if (current === "collapsed") return "expanded"
  return "collapsed"
}
