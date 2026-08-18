import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdir } from "node:fs/promises"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { BackgroundJob } from "@/background/job"
import { Event } from "@opencode-ai/core/event"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    BackgroundJob.node,
    Event.node,
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    [LocationServiceMap.node, buildLocationServiceMap()],
    [SessionExecution.node, SessionExecutionLocal.node],
  ],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session job HTTP owner", () => {
  it.instance(
    "job of session A is 404 under session B",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const a = yield* Session.use.create({ title: "owner-a" })
        const b = yield* Session.use.create({ title: "owner-b" })
        const jobs = yield* BackgroundJob.Service
        const job = yield* jobs.start({
          type: "bash",
          metadata: { sessionId: a.id, command: "sleep 30" },
          run: Effect.never.pipe(Effect.as("nope")),
        })

        const crossGet = yield* request(pathFor(SessionPaths.job, { sessionID: b.id, jobID: job.id }), { headers })
        expect(crossGet.status).toBe(404)

        const crossKill = yield* request(pathFor(SessionPaths.jobKill, { sessionID: b.id, jobID: job.id }), {
          headers,
          method: "POST",
        })
        expect(crossKill.status).toBe(404)

        const crossWait = yield* request(pathFor(SessionPaths.jobWait, { sessionID: b.id, jobID: job.id }), {
          headers,
          method: "POST",
        })
        expect(crossWait.status).toBe(404)

        const crossPromote = yield* request(pathFor(SessionPaths.jobPromote, { sessionID: b.id, jobID: job.id }), {
          headers,
          method: "POST",
        })
        expect(crossPromote.status).toBe(404)

        const listedB = yield* request(pathFor(SessionPaths.jobs, { sessionID: b.id }), { headers })
        expect(listedB.status).toBe(200)
        expect(((yield* responseJson(listedB)) as Array<{ id: string }>).some((item) => item.id === job.id)).toBe(false)

        const own = yield* request(pathFor(SessionPaths.job, { sessionID: a.id, jobID: job.id }), { headers })
        expect(own.status).toBe(200)
        expect(yield* responseJson(own)).toMatchObject({ id: job.id, type: "bash" })
        expect((yield* jobs.get(job.id))?.status).toBe("running")

        yield* jobs.cancel(job.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
