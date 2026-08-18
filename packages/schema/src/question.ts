export * as Question from "./question"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("Question.ID"),
  statics((schema) => {
    const create = () => schema.make("que_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Option = Schema.Struct({
  label: Schema.String.annotate({ description: "Display text (1-5 words, concise)" }),
  description: Schema.String.annotate({ description: "Explanation of choice" }),
}).annotate({ identifier: "Question.Option" })
export interface Option extends Schema.Schema.Type<typeof Option> {}

const base = {
  question: Schema.String.annotate({ description: "Complete question" }),
  header: Schema.String.annotate({ description: "Very short label (max 30 chars)" }),
  options: Schema.Array(Option).annotate({ description: "Available choices" }),
  multiple: Schema.Boolean.pipe(optional).annotate({ description: "Allow selecting multiple choices" }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.Boolean.pipe(optional).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}).annotate({ identifier: "Question.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Prompt = Schema.Struct(base).annotate({ identifier: "Question.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Tool = Schema.Struct({
  messageID: Schema.String,
  callID: Schema.String,
}).annotate({ identifier: "Question.Tool" })
export interface Tool extends Schema.Schema.Type<typeof Tool> {}

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({ description: "Questions to ask" }),
  tool: Tool.pipe(optional),
}).annotate({ identifier: "Question.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "Question.Answer" })
export type Answer = typeof Answer.Type

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "Question.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "Question.RepliedPayload" })
export interface Replied extends Schema.Schema.Type<typeof Replied> {}

export const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
}).annotate({ identifier: "Question.RejectedPayload" })
export interface Rejected extends Schema.Schema.Type<typeof Rejected> {}

const Asked = define({ type: "question.asked", schema: Request.fields })
const RepliedEvent = define({ type: "question.replied", schema: Replied.fields })
const RejectedEvent = define({ type: "question.rejected", schema: Rejected.fields })
export const Event = { Asked, Replied: RepliedEvent, Rejected: RejectedEvent, Definitions: inventory(Asked, RepliedEvent, RejectedEvent) }
