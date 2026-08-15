import { Schema } from "effect"
import { optional } from "./schema"
import { statics } from "./schema"

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface TextPart extends Schema.Schema.Type<typeof TextPart> {}
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Prompt.TextPart" })

export interface FilePart extends Schema.Schema.Type<typeof FilePart> {}
export const FilePart = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String.pipe(optional),
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Prompt.FilePart" })

export interface AgentPart extends Schema.Schema.Type<typeof AgentPart> {}
export const AgentPart = Schema.Struct({
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Prompt.AgentPart" })

export interface SubtaskPart extends Schema.Schema.Type<typeof SubtaskPart> {}
export const SubtaskPart = Schema.Struct({
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  command: Schema.String.pipe(optional),
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
  }).pipe(optional),
}).annotate({ identifier: "Prompt.SubtaskPart" })

export const Part = Schema.Union([TextPart, FilePart, AgentPart, SubtaskPart])
export type Part = Schema.Schema.Type<typeof Part>

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  parts: Schema.Array(Part).pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "files" | "agents" | "parts">) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.parts === undefined ? {} : { parts: input.parts }),
        }),
    })),
  )
