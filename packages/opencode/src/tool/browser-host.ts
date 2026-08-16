/**
 * Optional Playwright adapter for core Browser.Host.
 * If `playwright` cannot be imported, this module exports no host node so
 * browser_* tools stay unadvertised (config.browser.enabled still defaults off).
 */
export * as BrowserHostBridge from "./browser-host"

import { BrowserHost } from "@opencode-ai/core/tool/browser-host"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Effect, Layer } from "effect"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { MCP } from "../mcp"
import { McpCatalog } from "../mcp/catalog"

const MAX_TREE = 32_000

type PlaywrightModule = typeof import("playwright")
type Browser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

function playwrightResolves(): boolean {
  try {
    require.resolve("playwright")
    return true
  } catch {
    return false
  }
}

const hostLayer = Layer.effect(
  BrowserHost.HostService,
  Effect.sync(() => {
    let browser: Browser | undefined
    let page: Page | undefined
    const refs = new Map<string, string>()

    const ensurePage = () =>
      Effect.tryPromise({
        try: async () => {
          if (page) return page
          const playwright = await import("playwright")
          browser = await playwright.chromium.launch({ headless: true })
          page = await browser.newPage()
          return page
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.orDie)

    const assignRefs = (node: unknown, counter: { n: number }): unknown => {
      if (!node || typeof node !== "object") return node
      const record = node as Record<string, unknown>
      const id = `e${counter.n++}`
      const role = typeof record.role === "string" ? record.role : "generic"
      const name = typeof record.name === "string" ? record.name : ""
      refs.set(id, `${role}${name ? `[name="${name.replaceAll('"', '\\"')}"]` : ""}`)
      const children = Array.isArray(record.children)
        ? record.children.map((child) => assignRefs(child, counter))
        : undefined
      return { ref: id, role, name, ...(children ? { children } : {}) }
    }

    return BrowserHost.HostService.of({
      navigate: (url) =>
        ensurePage().pipe(
          Effect.flatMap((current) =>
            Effect.tryPromise({
              try: async () => {
                await current.goto(url, { waitUntil: "domcontentloaded" })
                return { title: await current.title(), url: current.url() }
              },
              catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
            }).pipe(Effect.orDie),
          ),
        ),
      snapshot: () =>
        ensurePage().pipe(
          Effect.flatMap((current) =>
            Effect.tryPromise({
              try: async () => {
                refs.clear()
                const tree = await current.accessibility.snapshot()
                const labeled = assignRefs(tree, { n: 1 })
                let text = JSON.stringify(labeled, null, 2)
                if (text.length > MAX_TREE) text = `${text.slice(0, MAX_TREE)}\n…truncated`
                return { tree: text }
              },
              catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
            }).pipe(Effect.orDie),
          ),
        ),
      click: (ref) =>
        ensurePage().pipe(
          Effect.flatMap((current) =>
            Effect.tryPromise({
              try: async () => {
                const selector = refs.get(ref)
                if (!selector) throw new Error(`Unknown snapshot ref: ${ref}`)
                await current.locator(selector).first().click()
                return { ok: true }
              },
              catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
            }).pipe(Effect.orDie),
          ),
        ),
      type: (ref, text) =>
        ensurePage().pipe(
          Effect.flatMap((current) =>
            Effect.tryPromise({
              try: async () => {
                const selector = refs.get(ref)
                if (!selector) throw new Error(`Unknown snapshot ref: ${ref}`)
                await current.locator(selector).first().fill(text)
                return { ok: true }
              },
              catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
            }).pipe(Effect.orDie),
          ),
        ),
    })
  }),
)

export const hostNode = makeGlobalNode({
  service: BrowserHost.HostService,
  layer: hostLayer,
  deps: [],
})

const mcpServerName = () => process.env.OPENCODE_BROWSER_MCP?.trim() ?? ""

const mcpText = (result: { content?: Array<{ type?: string; text?: string }> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")

const mcpHostLayer = Layer.effect(
  BrowserHost.HostService,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const server = mcpServerName()
    const call = (kind: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const tools = yield* mcp.tools()
        const prefix = `${McpCatalog.toolName(server, "").replace(/_$/, "")}_`
        const entry = Object.values(tools).find((item) => {
          const key = McpCatalog.toolName(server, item.def.name)
          return key.startsWith(prefix) && item.def.name.toLowerCase().includes(kind)
        })
        if (!entry) return yield* Effect.die(new Error(`OPENCODE_BROWSER_MCP server "${server}" has no ${kind} tool`))
        return yield* Effect.tryPromise({
          try: () =>
            entry.client.callTool(
              { name: entry.def.name, arguments: args },
              CallToolResultSchema,
              { timeout: entry.timeout },
            ),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        }).pipe(Effect.orDie)
      })
    return BrowserHost.HostService.of({
      navigate: (url) =>
        call("navigate", { url }).pipe(
          Effect.map((result) => {
            const text = mcpText(result as { content?: Array<{ type?: string; text?: string }> })
            try {
              const parsed = JSON.parse(text) as { title?: string; url?: string }
              return { title: parsed.title ?? text, url: parsed.url ?? url }
            } catch {
              return { title: text || url, url }
            }
          }),
        ),
      snapshot: () =>
        call("snapshot", {}).pipe(
          Effect.map((result) => ({
            tree: mcpText(result as { content?: Array<{ type?: string; text?: string }> }),
          })),
        ),
      click: (ref) => call("click", { ref }).pipe(Effect.map(() => ({ ok: true }))),
      type: (ref, text) => call("type", { ref, text }).pipe(Effect.map(() => ({ ok: true }))),
    })
  }),
)

export const mcpHostNode = makeGlobalNode({
  service: BrowserHost.HostService,
  layer: mcpHostLayer,
  deps: [MCP.node],
})

/** Playwright wins when installed; otherwise adapt a named connected MCP server. */
export const nodes = playwrightResolves() ? [hostNode] : mcpServerName() ? [mcpHostNode] : []
