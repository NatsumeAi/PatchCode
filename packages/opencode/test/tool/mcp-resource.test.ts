import { describe, expect, test } from "bun:test"
import { formatMcpResourceContent, MAX_MCP_RESOURCE_BLOB_BYTES } from "@/tool/dynamic-tools"

describe("MCP resource formatting", () => {
  test("omits blobs over the 10MB official cap", () => {
    const oversized = Buffer.alloc(MAX_MCP_RESOURCE_BLOB_BYTES + 1, 1).toString("base64")
    const formatted = formatMcpResourceContent("docs", "mcp://blob", {
      contents: [{ uri: "mcp://blob", mimeType: "image/png", blob: oversized }],
    })
    expect(formatted.attachments).toEqual([])
    expect(formatted.text).toContain("exceeds")
    expect(formatted.text).toContain("10 MB")
  })

  test("keeps text contents", () => {
    const formatted = formatMcpResourceContent("docs", "mcp://readme", {
      contents: [{ uri: "mcp://readme", mimeType: "text/plain", text: "hello" }],
    })
    expect(formatted.text).toContain("hello")
    expect(formatted.attachments).toEqual([])
  })
})
