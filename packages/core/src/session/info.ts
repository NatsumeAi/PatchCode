import { DateTime } from "effect"
import { Agent } from "../agent"
import { Location } from "../location"
import { Model } from "../model"
import { Project } from "../project"
import { Provider } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { Workspace } from "../workspace"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionMessage } from "./message"
import { Snapshot } from "../snapshot"
import { pinSession } from "../sandbox/resolve"

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  if (row.sandbox_profile) pinSession(row.id, row.sandbox_profile)
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: Project.ID.make(row.project_id),
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    agent: row.agent ? Agent.ID.make(row.agent) : undefined,
    model: row.model
      ? {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          variant: Model.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? Workspace.ID.make(row.workspace_id) : undefined,
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    revert: row.revert ? { ...row.revert, messageID: SessionMessage.ID.make(row.revert.messageID) } : undefined,
    sandboxProfile: row.sandbox_profile,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}
