export * as Workspace from "./workspace"

import { Workspace as WorkspaceSchema } from "@opencode-ai/schema/workspace"

export const ID = WorkspaceSchema.ID
export type ID = typeof ID.Type
