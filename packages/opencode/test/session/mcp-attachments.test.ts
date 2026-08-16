import { describe, expect, test } from "bun:test"
import { McpAttachments } from "../../src/session/mcp-attachments"

describe("McpAttachments.expand", () => {
  test("attaches supported image blobs as data URLs", () => {
    const blob = Buffer.from("hello").toString("base64")
    const expanded = McpAttachments.expand("mcp://img", [{ uri: "mcp://img", mimeType: "image/png", blob }])
    expect(expanded.attachments).toEqual([
      {
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${blob}`,
        filename: "mcp://img",
      },
    ])
    expect(expanded.text[0]).toContain("Binary MCP resource attached")
  })

  test("omits unsupported and oversized blobs", () => {
    const small = Buffer.from("x").toString("base64")
    const huge = "A".repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3))
    expect(
      McpAttachments.expand("mcp://bin", [{ uri: "mcp://bin", mimeType: "application/octet-stream", blob: small }])
        .text[0],
    ).toContain("is not a supported attachment type")
    expect(
      McpAttachments.expand("mcp://big", [{ uri: "mcp://big", mimeType: "image/png", blob: huge }]).text[0],
    ).toContain("exceeds")
  })
})
