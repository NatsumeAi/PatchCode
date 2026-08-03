import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

interface QaItem {
  question: string
  answer: string
}

function parseQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (item == null || typeof item !== "object") return []
    const q = (item as Record<string, unknown>).question
    return typeof q === "string" ? [q] : []
  })
}

function parseAnswers(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const meta = metadata(part)
  const questions = parseQuestions(inp.questions)
  const answers = parseAnswers(meta.answers)
  const answered = answers.length > 0
  const details = answered ? `${answers.length} answered` : `${questions.length} questions`
  return {
    verb: "Questions",
    icon: "\u2192",
    family: "question",
    primary: "",
    details,
    muted: false,
    status: part.state.status,
    accent: "question",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const inp = input(part)
  const meta = metadata(part)
  const questions = parseQuestions(inp.questions)
  const answers = parseAnswers(meta.answers)
  if (answers.length === 0) return { kind: "none" }
  const items: QaItem[] = questions.map((q, i) => ({
    question: q,
    answer: (answers[i] ?? []).join(", ") || "(no answer)",
  }))
  return { kind: "qa", items }
}

export const questionDescriptor: ToolDescriptor = {
  names: ["question"],
  family: "question",
  policy,
  header,
  body,
}
