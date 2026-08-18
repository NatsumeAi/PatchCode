import type { FileNode } from "@opencode-ai/sdk/api"

export type FileTreeModel = {
  children: ReadonlyMap<string, readonly FileTreeNode[]>
  total: number
}

export type FileTreeNode = FileNode & { originalPath: string }

export type FileTreeRow = {
  node: FileTreeNode
  level: number
}

export function normalizeFileTreePath(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

export function buildFileTreeModel(paths: readonly string[]): FileTreeModel {
  const nodes = new Map<string, FileTreeNode>()

  paths.forEach((value) => {
    const file = normalizeFileTreePath(value)
    if (!file) return

    const parts = file.split("/")
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/")
      if (nodes.has(path)) return
      nodes.set(path, {
        name,
        path,
        absolute: path,
        type: index === parts.length - 1 ? "file" : "directory",
        ignored: false,
        originalPath: index === parts.length - 1 ? value : path,
      })
    })
  })

  const children = new Map<string, FileTreeNode[]>()
  nodes.forEach((node) => {
    const index = node.path.lastIndexOf("/")
    const parent = index === -1 ? "" : node.path.slice(0, index)
    const list = children.get(parent)
    if (list) list.push(node)
    else children.set(parent, [node])
  })
  children.forEach((nodes) =>
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    }),
  )

  return { children, total: nodes.size }
}

export function flattenFileTree(model: FileTreeModel, expanded: (path: string) => boolean) {
  const rows: FileTreeRow[] = []
  const stack = (model.children.get("") ?? []).toReversed().map((node) => ({ node, level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const children = model.children.get(row.node.path) ?? []
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index]!, level: row.level + 1 })
    }
  }

  return rows
}

export function flattenLiveFileTree(
  children: (path: string) => readonly FileNode[],
  expanded: (path: string) => boolean,
) {
  const rows: FileTreeRow[] = []
  const stack = children("")
    .toReversed()
    .map((node) => ({ node: toLiveNode(node), level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const nested = children(row.node.originalPath)
    for (let index = nested.length - 1; index >= 0; index--) {
      stack.push({ node: toLiveNode(nested[index]!), level: row.level + 1 })
    }
  }

  return rows
}

function toLiveNode(node: FileNode): FileTreeNode {
  return {
    ...node,
    path: normalizeFileTreePath(node.path),
    originalPath: node.path,
  }
}
