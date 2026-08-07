# V1 runtime consumer inventory (2026-08-07)

> Inventory only — do not delete still-live or compat-support nodes without a follow-up PR after consumers are gone.
> Main prompt/command/shell/compact paths are already V2. Do not claim “main path still V1”.

| Node / service | Tag | Evidence / consumers | Action |
|---|---|---|---|
| `SessionRevert` (`opencode/.../session/revert.ts`) | **compat → migrating** | Instance HTTP handlers switched to `SessionV2.revert.*` (2026-08-07). Still registered in `httpapi/server.ts`; `RevertPayload` schema still imports `RevertInput`. Tests: `revert-compact.test.ts` still exercise V1 service. | Keep registered until V1 tests migrated or deleted; then dead-reg PR |
| `SessionRunState` | compat-support / still-live for V1 tests | Used by V1 `SessionRevert.assertNotBusy`, V1 prompt paths. Instance HTTP busy now uses `v2Svc.active`. | Do not delete while V1 revert tests / leftover V1 callers exist |
| `SessionPrompt` | still-live (legacy) + dead for Instance HTTP prompt | Instance HTTP `prompt`/`promptAsync`/`command`/`shell` use V2. V1 prompt still imported by older tests and possibly control-plane leftovers. | Inventory call sites before unregister |
| `SessionProcessor` | still-live for V1 | V1 loop processor | Leave until SessionPrompt retire |
| V1 `SessionCompaction` | compat / legacy | V2 compaction is primary; V1 may remain for old tests | Leave |
| `SessionSummary` | still-live | Instance HTTP `diff` / summary compute; V1 revert historically used it | Keep |
| `Permission.Service` (V1) | **compat** | Instance `permissionRespond` + `/permission/{id}/reply`; TUI uses PermissionV2 only | Retain deprecated surface; no dual-write |
| `Question` V1 reply (if any Instance path) | compat | Same policy as permission | Inventory; do not merge with permission |

## Labels

| Tag | Meaning |
|---|---|
| dead-reg | Zero runtime callers — safe to unregister in a dedicated PR |
| compat-support | Only supports deprecated/compat endpoints |
| still-live | Real consumers remain — **do not delete** |
| migrating | Callers moved; registration/tests not yet cleaned |
