import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect } from "effect"
import * as ApiError from "../errors"
import { ApiNotFoundError } from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

export function mapV2Write<A, E, R>(self: Effect.Effect<A, E, R>) {
  return self.pipe(
    Effect.catchIf(
      (error): error is SessionV2.SessionBusyError => error instanceof SessionV2.SessionBusyError,
      (error) =>
        Effect.fail(
          new ApiError.SessionBusyError({
            sessionID: error.sessionID,
            message: `Session is busy: ${error.sessionID}`,
          }),
        ),
    ),
    Effect.catchIf(
      (error): error is SessionV2.NotFoundError => error instanceof SessionV2.NotFoundError,
      (error) =>
        Effect.fail(
          new ApiNotFoundError({
            name: "NotFoundError",
            data: { message: error.message },
          }),
        ),
    ),
  )
}
