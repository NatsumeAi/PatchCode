import { describe, expect, test } from "bun:test"
import { assertLiveModel, GO_FLASH, ZEN_FLASH, ZEN_FLASH_FREE } from "./allowlist"

describe("live allowlist", () => {
  test("accepts the three rows", () => {
    expect(() => assertLiveModel(GO_FLASH)).not.toThrow()
    expect(() => assertLiveModel(ZEN_FLASH)).not.toThrow()
    expect(() => assertLiveModel(ZEN_FLASH_FREE)).not.toThrow()
  })

  test("throws on any other host or model", () => {
    expect(() =>
      assertLiveModel({
        providerID: "openai",
        modelID: "gpt-4o",
        baseURL: "https://api.openai.com/v1",
      }),
    ).toThrow(/allowlist/)
    expect(() =>
      assertLiveModel({
        providerID: "opencode-go",
        modelID: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com",
      }),
    ).toThrow(/allowlist/)
  })
})
