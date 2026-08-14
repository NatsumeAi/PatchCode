import * as OpenAICompatible from "../../src/providers/openai-compatible"

export type LiveModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly baseURL: string
}

export const GO_FLASH: LiveModelRef = {
  providerID: "opencode-go",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/go/v1",
}

export const ZEN_FLASH: LiveModelRef = {
  providerID: "opencode",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/v1",
}

export const ZEN_FLASH_FREE: LiveModelRef = {
  providerID: "opencode",
  modelID: "deepseek-v4-flash-free",
  baseURL: "https://opencode.ai/zen/v1",
}

const ALLOWED: ReadonlyArray<LiveModelRef> = [GO_FLASH, ZEN_FLASH, ZEN_FLASH_FREE]

export const assertLiveModel = (ref: LiveModelRef) => {
  const ok = ALLOWED.some(
    (row) => row.providerID === ref.providerID && row.modelID === ref.modelID && row.baseURL === ref.baseURL,
  )
  if (!ok) throw new Error(`live allowlist rejected ${ref.providerID}/${ref.modelID} @ ${ref.baseURL}`)
}

export const liveEnabled = () => process.env.LIVE_CACHE === "1" || process.env.RECORD === "true"

export const goApiKey = () => process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY

export const zenApiKey = () => process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY

export const goModel = () => {
  assertLiveModel(GO_FLASH)
  return OpenAICompatible.configure({
    provider: GO_FLASH.providerID,
    baseURL: GO_FLASH.baseURL,
    apiKey: goApiKey() ?? "missing",
  }).model(GO_FLASH.modelID)
}

export const zenModel = (free = false) => {
  const ref = free ? ZEN_FLASH_FREE : ZEN_FLASH
  assertLiveModel(ref)
  const allowed = process.env.OPENCODE_ZEN_CACHE_MODEL
  if (allowed && allowed !== ref.modelID) throw new Error(`OPENCODE_ZEN_CACHE_MODEL rejected: ${allowed}`)
  return OpenAICompatible.configure({
    provider: ref.providerID,
    baseURL: ref.baseURL,
    apiKey: zenApiKey() ?? "missing",
  }).model(ref.modelID)
}
