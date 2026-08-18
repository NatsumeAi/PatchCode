/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/api"
import { tmpdir } from "../../../fixture/fixture"
import { subagentsOf } from "../../../../src/feature-plugins/sidebar/subagents"
import { json, mount, wait } from "./sync-fixture"

const parentID = "ses_parent_created"
const childID = "ses_child_created"
const directory = "/tmp/opencode/packages/opencode"

const parent = {
  id: parentID,
  title: "parent",
  time: { created: 0, updated: 0 },
  version: "local",
  directory,
  agent: "build",
}

const child = {
  id: childID,
  parentID,
  title: "Explore (@explore subagent)",
  time: { created: 1, updated: 1 },
  version: "local",
  directory,
  agent: "explore",
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

test("session.created upserts child into sync store for sidebar Subagents", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${parentID}`) return json(parent)
    if (url.pathname === `/session/${parentID}/message`) return json([])
    if (url.pathname === `/session/${parentID}/todo` || url.pathname === `/session/${parentID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(
      global({
        id: "evt_parent",
        type: "session.updated",
        properties: { sessionID: parentID, info: parent as never },
      }),
    )
    await wait(() => !!sync.session.get(parentID))

    emit(
      global({
        id: "evt_child_created",
        type: "session.created",
        properties: { sessionID: childID, info: child as never },
      }),
    )
    await wait(() => !!sync.session.get(childID))

    const listed = sync.data.session
    expect(listed.some((s) => s.id === childID && s.parentID === parentID)).toBe(true)
    const subagents = subagentsOf(listed, parentID, () => false)
    expect(subagents).toHaveLength(1)
    expect(subagents[0]?.id).toBe(childID)
    expect(subagents[0]?.agent).toBe("explore")
  } finally {
    app.renderer.destroy()
  }
})
