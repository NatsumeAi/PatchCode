# Minimal Browser Tool Design (W8g)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-browser-min.md`.

**Goal:** Coding-needed browser **capability** without Hermes/OpenClaw. Honest: this host will not ship Chromium in-tree.

**Proven:** `webfetch` / `websearch` exist. `mcp/browser.ts` opens a URL for OAuth only. `computer_use` is protocol mapping, not a tool. No CDP.

## Rejected

- Claiming computer_use is a browser.
- Vendoring Chromium / Playwright into default CI.
- Full Hermes snapshot/click/type/scroll suite as core without a host.
- Using `webfetch` UA spoof as “browser”.

## Product

`Browser.Host` (optional, like `Task.Host`):

```
navigate(url) → { title, url }
snapshot() → accessibility/text tree (string, bounded)
click(ref) / type(ref, text)
```

Core tools `browser_navigate`, `browser_snapshot`, `browser_act` **always register** and fail `Browser.Unavailable` if no host.

Host implementation lives in opencode: if `playwright` resolves **or** env `OPENCODE_BROWSER_MCP` points at an MCP server already connected, adapt that. Otherwise no host layer is provided.

SSRF: `Net.denyHost` (same helper as W5 project HTTP and W8f). No metadata/link-local. W1 does not wrap in-process host; network policy is the URL allow/deny.

Default **off** in materialize unless `config.browser.enabled === true` **and** host present (don’t advertise dead tools).

## Anti-fake

1. Without host + enabled: tools absent from definitions **or** present and settle → `Unavailable` (locked: **absent** when disabled/unavailable).
2. With a fake Host: navigate + snapshot return host values; click called.
3. `navigate("http://169.254.169.254/")` denied before Host.
4. `webfetch.ts` is not imported by browser tools.
5. No `computer_use` string in the new tool files.
