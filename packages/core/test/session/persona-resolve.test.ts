import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PersonaResolve } from "../../src/session/persona/resolve"
import { PersonaLoader } from "../../src/session/persona/loader"
import { PersonaInject } from "../../src/session/persona/inject"
import { fingerprintInstructions } from "../../src/session/persona/fingerprint"

test("parsePersonaMarkdown reads frontmatter and body", () => {
  const info = PersonaLoader.parsePersonaMarkdown(
    "fallback",
    `---
name: researcher
description: Deep research
capability: read-only
inputs: paths, logs
outputs: summary
---
You are a careful researcher.
`,
  )
  expect(info.name).toBe("researcher")
  expect(info.description).toContain("research")
  expect(info.capability).toBe("read-only")
  expect(info.instructions).toContain("careful researcher")
})

test("resolve precedence: task override wins", async () => {
  const catalog = new Map([
    ["agentp", { name: "agentp", instructions: "agent default body" }],
    ["taskp", { name: "taskp", instructions: "task override body" }],
  ])
  const eff = await PersonaResolve.resolve({
    taskPersona: "taskp",
    agentDefaultPersona: "agentp",
    catalog,
  }).pipe(Effect.runPromise)
  expect(eff.source).toBe("task_override")
  expect(eff.personaName).toBe("taskp")
  expect(eff.instructions).toContain("task override")
  expect(eff.fingerprint).toBe(fingerprintInstructions(eff.instructions))
})

test("formatPersonaSystem wraps grok-style tags", () => {
  const text = PersonaInject.formatPersonaSystem({
    instructions: "Be terse.",
    source: "task_override",
    fingerprint: "abc",
    personaName: "terse",
  })
  expect(text).toContain("<persona>")
  expect(text).toContain("Be terse.")
  expect(text).toContain("</persona>")
})
