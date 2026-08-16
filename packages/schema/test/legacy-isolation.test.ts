import { expect, test } from "bun:test"
import { LegacyEvent } from "../src/legacy-event"
import { PermissionV1 } from "../src/permission-legacy"
import { QuestionV1 } from "../src/question-legacy"
import { SessionV1 } from "../src/session-legacy"
import { LegacyEvent as IsolatedLegacyEvent } from "../src/legacy/legacy-event"
import { PermissionV1 as IsolatedPermissionV1 } from "../src/legacy/permission"
import { QuestionV1 as IsolatedQuestionV1 } from "../src/legacy/question"
import { SessionV1 as IsolatedSessionV1 } from "../src/legacy/session"

test("compatibility entrypoints preserve isolated V1 schema identity", () => {
  expect(LegacyEvent).toBe(IsolatedLegacyEvent)
  expect(PermissionV1).toBe(IsolatedPermissionV1)
  expect(QuestionV1).toBe(IsolatedQuestionV1)
  expect(SessionV1).toBe(IsolatedSessionV1)
})

test("current source does not import the V1 subtree directly", async () => {
  const allowed = new Set(["legacy-event.ts", "permission-legacy.ts", "question-legacy.ts", "session-legacy.ts"])
  const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
    (file) => !allowed.has(file),
  )
  const directImports = await Promise.all(
    files.map(async (file) => ({ file, source: await Bun.file(new URL(`../src/${file}`, import.meta.url)).text() })),
  ).then((values) => values.filter((value) => value.source.includes('from "./legacy/')))

  expect(directImports).toEqual([])
})
