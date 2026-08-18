export * as Provider from "./provider"

import { Types } from "effect"
import { Provider as ProviderSchema } from "@opencode-ai/schema/provider"

export const ID = ProviderSchema.ID
export type ID = typeof ID.Type

export const AISDK = ProviderSchema.AISDK

export const Native = ProviderSchema.Native

export const Api = ProviderSchema.Api
export type Api = ProviderSchema.Api
export type MutableApi<T extends Api = Api> = T extends Api
  ? Omit<Types.DeepMutable<T>, "settings"> & (undefined extends T["settings"] ? { settings?: any } : { settings: any })
  : never

export const Request = ProviderSchema.Request
export type Request = ProviderSchema.Request

export const Info = ProviderSchema.Info
export type Info = ProviderSchema.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & { api: MutableApi }
