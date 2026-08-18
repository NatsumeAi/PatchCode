export * as EventManifest from "./event-manifest"

import { Catalog } from "./catalog"
import { Durable } from "./durable-event-manifest"
import { Event } from "./event"
import { FileSystem } from "./filesystem"
import { FileSystemWatcher } from "./filesystem-watcher"
import { InstallationEvent } from "./installation-event"
import { Integration } from "./integration"
import { LegacyEvent } from "./legacy-event"
import { LspEvent } from "./lsp-event"
import { McpEvent } from "./mcp-event"
import { ModelsDev } from "./models-dev"
import { Permission } from "./permission"
import { Plugin } from "./plugin"
import { Project } from "./project"
import { ProjectDirectories } from "./project-directories"
import { Pty } from "./pty"
import { Question } from "./question"
import { Reference } from "./reference"
import { ServerEvent } from "./server-event"
import { SessionCompactionEvent } from "./session-compaction-event"
import { SessionEvent } from "./session-event"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTodo } from "./session-todo"
import { SessionWire } from "./session-legacy"
import { TuiEvent } from "./tui-event"
import { VcsEvent } from "./vcs-event"
import { WorkspaceEvent } from "./workspace-event"
import { WorktreeEvent } from "./worktree-event"

const sessionWireDurableDefinitions = SessionWire.Event.Definitions.filter((definition) => definition.durable !== undefined)
const sessionWireLiveDefinitions = SessionWire.Event.Definitions.filter((definition) => definition.durable === undefined)

const coreDefinitions = Event.inventory(...sessionWireDurableDefinitions, ...SessionEvent.Definitions)

const foundationDefinitions = Event.inventory(
  ...ModelsDev.Event.Definitions,
  ...Integration.Event.Definitions,
  ...Catalog.Event.Definitions,
  ...coreDefinitions,
)

const featureDefinitions = Event.inventory(
  ...FileSystem.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Permission.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...ProjectDirectories.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
)

export const ServerDefinitions = Event.inventory(
  ...foundationDefinitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
)

export const Definitions = Event.inventory(
  ...foundationDefinitions,
  ...sessionWireLiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...LspEvent.Definitions,
  ...TuiEvent.Definitions,
  ...McpEvent.Definitions,
  ...LegacyEvent.Definitions,
  ...Project.Event.Definitions,
  ...SessionStatusEvent.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...WorktreeEvent.Definitions,
  ...ServerEvent.Definitions,
)
export const Latest = Event.latest(Definitions)
export { Durable }
