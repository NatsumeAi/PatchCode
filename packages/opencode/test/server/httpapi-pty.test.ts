import { afterEach, describe, expect, test } from "bun:test"
import { Context, Schema } from "effect"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>
const testPty = process.platform === "win32" ? test.skip : test

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 pty HttpApi", () => {
  testPty("serves location-wrapped PTY routes and retains exited sessions", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })

    const empty = await request("/api/pty", tmp.path)
    expect(empty.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await empty.json()).data).toEqual([])

    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "exit 4"], title: "v2" }),
    })
    expect(created.status).toBe(200)
    const body = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json())
    expect(String(body.location.directory)).toBe(tmp.path)
    expect(body.data.title).toBe("v2")

    const deadline = Date.now() + 5_000
    let info: { status: string; exitCode?: number } | undefined
    while (Date.now() < deadline) {
      const found = await request(`/api/pty/${body.data.id}`, tmp.path)
      expect(found.status).toBe(200)
      info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await found.json()).data
      if (info.status === "exited") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(info).toMatchObject({ status: "exited", exitCode: 4 })

    const removed = await request(`/api/pty/${body.data.id}`, tmp.path, { method: "DELETE" })
    expect(removed.status).toBe(204)

    const missing = await request(`/api/pty/${body.data.id}`, tmp.path)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "PtyNotFoundError", ptyID: body.data.id })
  })

  testPty("rejects connect tokens without the CSRF header and connects with a valid ticket", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 5"] }),
    })
    expect(created.status).toBe(200)
    const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

    try {
      const forbidden = await request(`/api/pty/${info.id}/connect-token`, tmp.path, { method: "POST" })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({ _tag: "ForbiddenError" })

      const token = await request(`/api/pty/${info.id}/connect-token`, tmp.path, {
        method: "POST",
        headers: { "x-opencode-ticket": "1" },
      })
      expect(token.status).toBe(200)
      const ticket = Schema.decodeUnknownSync(Location.response(PtyTicket.ConnectToken))(await token.json()).data.ticket
      expect(ticket).toBeTruthy()

      const invalid = await request(`/api/pty/${info.id}/connect?ticket=not-a-ticket`, tmp.path)
      expect(invalid.status).toBe(403)
    } finally {
      await request(`/api/pty/${info.id}`, tmp.path, { method: "DELETE" })
    }
  })
})
