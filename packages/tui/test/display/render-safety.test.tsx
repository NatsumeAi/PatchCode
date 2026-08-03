/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ToolViewModel, ReasoningViewModel } from "@opencode-ai/session-display"
import { ToolEntry } from "../../src/display/ToolEntry"
import { ReasoningEntry } from "../../src/display/ReasoningEntry"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider, type Resolved } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { TuiPathsProvider } from "../../src/context/runtime"
import type { RGBA } from "@opentui/core"

const config = {
  genericToolOutput: false,
  showDetails: false,
  groupToolVerbs: true,
  diffStyle: "auto",
  scrollSpeed: 1,
  scrollAcceleration: 1,
  thinking: { streaming: "truncated", finished: "collapsed" },
} as unknown as Resolved

function vm(overrides: Partial<ToolViewModel> = {}): ToolViewModel {
  return {
    mode: "collapsed",
    header: {
      verb: "Read",
      icon: "→",
      family: "read",
      primary: "src/foo.ts",
      details: "",
      muted: false,
      dimDetails: true,
      status: "completed",
      accent: "read",
    },
    body: { kind: "none" },
    userPinned: false,
    clickable: true,
    chrome: "inline",
    ...overrides,
  }
}

async function renderTool(overrides: Partial<ToolViewModel> = {}) {
  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: "/tmp/state", worktree: "/tmp" }}>
      <KVProvider>
        <TuiConfigProvider config={config}>
          <ThemeProvider mode="dark">
            <ToolEntry vm={vm(overrides)} partId="prt_x" onClick={() => {}} width={80} />
          </ThemeProvider>
        </TuiConfigProvider>
      </KVProvider>
    </TuiPathsProvider>
  ))
  return app
}

describe("ToolEntry render safety", () => {
  test("collapsed completed", async () => {
    await renderTool()
    expect(true).toBe(true)
  })

  test("expanded completed with text body", async () => {
    await renderTool({ mode: "expanded", body: { kind: "text", text: "hello" }, chrome: "panel" })
    expect(true).toBe(true)
  })

  test("truncated running with details", async () => {
    await renderTool({
      mode: "truncated",
      header: { ...vm().header, status: "running", details: "5ms" },
      body: { kind: "lines", lines: ["a", "b", "c", "d"] },
    })
    expect(true).toBe(true)
  })

  test("error status", async () => {
    await renderTool({
      mode: "expanded",
      header: { ...vm().header, status: "error", accent: "error", primary: "bash" },
      body: { kind: "text", text: "command failed" },
    })
    expect(true).toBe(true)
  })

  test("empty verb and primary strings", async () => {
    await renderTool({
      header: { ...vm().header, verb: "", primary: "", details: "" },
    })
    expect(true).toBe(true)
  })

  test("all body kinds", async () => {
    const bodies: ToolViewModel["body"][] = [
      { kind: "diff", diff: "--- a\n+++ b", path: "a.ts" },
      { kind: "patch", files: [{ path: "a.ts", diff: "diff", type: "modified" }] },
      { kind: "code", content: "fn main() {}", path: "main.rs" },
      { kind: "todos", items: [{ status: "pending", content: "do" }] },
      { kind: "qa", items: [{ question: "q?", answer: "a" }] },
    ]
    for (const body of bodies) {
      await renderTool({ mode: "expanded", body, chrome: "panel" })
    }
    expect(true).toBe(true)
  })
})

describe("ReasoningEntry render safety", () => {
  function rvm(overrides: Partial<ReasoningViewModel> = {}): ReasoningViewModel {
    return {
      mode: "collapsed",
      title: null,
      body: "thinking…",
      durationMs: null,
      userPinned: false,
      status: "done",
      clickable: true,
      ...overrides,
    }
  }

  test("streaming with duration", async () => {
    const app = await testRender(() => (
      <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: "/tmp/state", worktree: "/tmp" }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <ReasoningEntry vm={rvm({ status: "streaming", durationMs: 1500, body: "" })} onClick={() => {}} conceal={false} />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiPathsProvider>
    ))
    expect(app).toBeDefined()
  })

  test("done with title and empty body", async () => {
    const app = await testRender(() => (
      <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: "/tmp/state", worktree: "/tmp" }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <ReasoningEntry
                vm={rvm({ title: "Planning", body: "", durationMs: 500 })}
                onClick={() => {}}
                conceal={false}
              />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiPathsProvider>
    ))
    expect(app).toBeDefined()
  })

  test("expanded truncated body", async () => {
    const app = await testRender(() => (
      <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: "/tmp/state", worktree: "/tmp" }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <ReasoningEntry
                vm={rvm({ mode: "truncated", body: "line1\nline2\nline3\nline4" })}
                onClick={() => {}}
                conceal={false}
              />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiPathsProvider>
    ))
    expect(app).toBeDefined()
  })
})

describe("dirty data safety (non-string fields never reach text nodes)", () => {
  function rvm(overrides: Partial<ReasoningViewModel> = {}): ReasoningViewModel {
    return {
      mode: "collapsed",
      title: null,
      body: "thinking…",
      durationMs: null,
      userPinned: false,
      status: "done",
      clickable: true,
      ...overrides,
    }
  }

  test("object details and primary render without crash", async () => {
    await renderTool({
      mode: "expanded",
      header: {
        ...vm().header,
        // @ts-expect-error dirty data simulation
        primary: { path: "src/foo.ts" },
        // @ts-expect-error dirty data simulation
        details: ["one", "two"],
      },
      body: { kind: "text", text: "ok" },
    })
    expect(true).toBe(true)
  })

  test("object lines entries render without crash", async () => {
    await renderTool({
      mode: "expanded",
      body: {
        kind: "lines",
        // @ts-expect-error dirty data simulation
        lines: ["clean", { raw: "dirty" }, 42, null, undefined],
      },
    })
    expect(true).toBe(true)
  })

  test("object todo content renders without crash", async () => {
    await renderTool({
      mode: "expanded",
      body: {
        kind: "todos",
        // @ts-expect-error dirty data simulation
        items: [{ status: "pending", content: { nested: "x" } }],
      },
    })
    expect(true).toBe(true)
  })

  test("object reasoning text renders without crash", async () => {
    const app = await testRender(() => (
      <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: "/tmp/state", worktree: "/tmp" }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <ReasoningEntry
                vm={rvm({
                  mode: "expanded",
                  // @ts-expect-error dirty data simulation
                  body: { nested: true },
                  title: null,
                })}
                onClick={() => {}}
                conceal={false}
              />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiPathsProvider>
    ))
    expect(app).toBeDefined()
  })
})
