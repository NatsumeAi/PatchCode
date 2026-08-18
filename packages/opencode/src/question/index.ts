import { Question } from "@opencode-ai/schema/question"

export const Option = Question.Option
export type Option = Question.Option
export const Info = Question.Info
export type Info = Question.Info
export const Prompt = Question.Prompt
export type Prompt = Question.Prompt
export const Tool = Question.Tool
export type Tool = Question.Tool
export const Request = Question.Request
export type Request = Question.Request
export const Answer = Question.Answer
export type Answer = Question.Answer
export const Reply = Question.Reply
export type Reply = Question.Reply
export const Replied = Question.Replied
export const Rejected = Question.Rejected
export const Event = Question.Event

export { RejectedError, NotFoundError } from "@opencode-ai/core/question"

export * as Question from "."
