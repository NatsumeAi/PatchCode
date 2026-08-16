export * as ExecPolicyParse from "./parse"

import { fileURLToPath } from "url"
import { Language, type Node, Parser } from "web-tree-sitter"

export type ClassifyResult =
  | { tag: "opaque"; source: string; reason: string }
  | { tag: "segments"; segments: string[][]; redirects?: string[] }

const WORD_ONLY = new Set([
  "program",
  "list",
  "pipeline",
  "command",
  "command_name",
  "word",
  "string",
  "string_content",
  "raw_string",
  "number",
  "concatenation",
  "variable_assignment",
  "variable_name",
  "redirected_statement",
  "file_redirect",
  "file_descriptor",
  "comment",
])

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const unquote = (text: string) => {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

const isWordOnlyKind = (kind: string) => WORD_ONLY.has(kind) || kind.startsWith("heredoc_")

const namedKinds = (node: Node, out: string[]) => {
  if (node.isNamed) out.push(node.type)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) namedKinds(child, out)
  }
}

const commandTokens = (node: Node) => {
  const tokens: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        if (
          item.type === "command_name" ||
          item.type === "word" ||
          item.type === "string" ||
          item.type === "raw_string" ||
          item.type === "concatenation" ||
          item.type === "number"
        ) {
          tokens.push(unquote(item.text))
        }
      }
      continue
    }
    if (
      child.type === "command_name" ||
      child.type === "word" ||
      child.type === "string" ||
      child.type === "raw_string" ||
      child.type === "concatenation" ||
      child.type === "number" ||
      child.type === "variable_assignment"
    ) {
      if (child.type === "variable_assignment") {
        tokens.push(child.text)
        continue
      }
      tokens.push(unquote(child.text))
    }
  }
  return tokens
}

const redirectTargets = (root: Node) => {
  const out: string[] = []
  const visit = (node: Node) => {
    if (node.type === "file_redirect" || node.type === "redirection") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (
          child.type === "word" ||
          child.type === "string" ||
          child.type === "raw_string" ||
          child.type === "concatenation" ||
          child.type === "number"
        ) {
          const text = unquote(child.text)
          if (text && text !== ">" && text !== ">>" && text !== "<" && text !== ">&") out.push(text)
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }
  }
  visit(root)
  return out
}

type Parsers = { bash: Parser; ps: Parser }

let parsers: Promise<Parsers> | undefined

const loadParsers = () => {
  parsers ??= (async () => {
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    await Parser.init({
      locateFile() {
        return resolveWasm(treeWasm)
      },
    })
    const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    })
    const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
      with: { type: "wasm" },
    })
    const [bashLanguage, psLanguage] = await Promise.all([
      Language.load(resolveWasm(bashWasm)),
      Language.load(resolveWasm(psWasm)),
    ])
    const bash = new Parser()
    bash.setLanguage(bashLanguage)
    const ps = new Parser()
    ps.setLanguage(psLanguage)
    return { bash, ps }
  })()
  return parsers
}

const shellKind = (shell: string) => {
  const base = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "bash"
  if (base === "cmd" || base === "cmd.exe") return "cmd" as const
  if (base.includes("powershell") || base === "pwsh" || base === "pwsh.exe") return "powershell" as const
  return "bash" as const
}

export const classify = async (command: string, shell = "bash"): Promise<ClassifyResult> => {
  const kind = shellKind(shell)
  if (kind === "cmd") return { tag: "opaque", source: command, reason: "cmd.exe has no grammar" }
  let root: Node
  try {
    const loaded = await loadParsers()
    const parser = kind === "powershell" ? loaded.ps : loaded.bash
    const tree = parser.parse(command)
    if (!tree) return { tag: "opaque", source: command, reason: "parse returned empty tree" }
    root = tree.rootNode
  } catch {
    return { tag: "opaque", source: command, reason: "parse threw" }
  }
  if (root.hasError) return { tag: "opaque", source: command, reason: "hasError" }
  const kinds: string[] = []
  namedKinds(root, kinds)
  for (const named of kinds) {
    if (!isWordOnlyKind(named)) return { tag: "opaque", source: command, reason: named }
  }
  const commands = root.descendantsOfType("command").filter((child): child is Node => Boolean(child))
  const segments = commands.map(commandTokens).filter((segment) => segment.length > 0)
  if (segments.length === 0) return { tag: "opaque", source: command, reason: "no commands" }
  return { tag: "segments", segments, redirects: redirectTargets(root) }
}
