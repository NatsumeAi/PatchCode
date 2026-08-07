# Permission / Question consumer matrix (2026-08-07)

## Decision (locked this pass)

- **Sole live ask/reply for TUI + tools:** PermissionV2 / QuestionV2 (protocol `/api/session/:id/permission|question/...`).
- **Instance deprecated endpoints:** retain as thin **compat** calling V1 `Permission.Service` (shared HTTP/V1 service verification from the original deprecate plan).
- **Do not** silently dual-write V1+V2.
- **Do not** merge permission and question into one endpoint.
- Full V1 permission stack removal only after this matrix shows zero readers.

## Consumers

| Surface | Path | Stack | Role |
|---|---|---|---|
| TUI permission UI | `packages/tui/src/routes/session/permission.tsx` | PermissionV2 reply | Live |
| TUI question UI | `packages/tui/src/routes/session/question.tsx` | QuestionV2 | Live |
| Core tools ask | `packages/core/src/permission.ts` | PermissionV2.ask/assert | Live |
| Protocol/server | `packages/server/src/handlers/permission.ts` | PermissionV2.reply | Live |
| Instance session `permissionRespond` | `opencode/.../handlers/session.ts` | V1 Permission.reply | Deprecated compat |
| Instance permission group | `opencode/.../handlers/permission.ts` | V1 Permission.reply | Deprecated compat |
| App server-compat | `packages/app/src/utils/server-compat.ts` | Prefer V2; legacy fallback | Compat bridge |

## Follow-up (not this pass)

If Instance clients are proven gone: forward Instance reply to PermissionV2 and unregister V1 reply authority in a dedicated PR.
