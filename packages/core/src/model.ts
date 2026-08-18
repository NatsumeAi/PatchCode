import { Types } from "effect"
import { Model as ModelSchema } from "@opencode-ai/schema/model"
import { Provider } from "./provider"

export const ID = ModelSchema.ID
export type ID = typeof ID.Type

export const VariantID = ModelSchema.VariantID
export type VariantID = typeof VariantID.Type

// Grouping of models, eg claude opus, claude sonnet
export const Family = ModelSchema.Family
export type Family = ModelSchema.Family

export const Capabilities = ModelSchema.Capabilities
export type Capabilities = ModelSchema.Capabilities

export const Cost = ModelSchema.Cost

export const Ref = ModelSchema.Ref
export type Ref = typeof Ref.Type

export const Api = ModelSchema.Api
export type Api = ModelSchema.Api

export const Info = ModelSchema.Info
export type Info = ModelSchema.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & {
  api: Provider.MutableApi<Api>
}

export function parse(input: string): { providerID: Provider.ID; modelID: ID } {
  const [providerID, ...modelID] = input.split("/")
  return {
    providerID: Provider.ID.make(providerID),
    modelID: ID.make(modelID.join("/")),
  }
}

export * as Model from "./model"
