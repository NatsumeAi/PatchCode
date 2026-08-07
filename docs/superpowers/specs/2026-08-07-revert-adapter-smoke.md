# Revert adapter smoke checklist (2026-08-07)

Automated coverage:

- `packages/core/test/session/revert-v2-adapter.test.ts` — stage / clear / commit / busy authority
- Projector: `session-projector.test.ts` staged/cleared/committed
- Instance HTTP handlers call `SessionV2.revert.stage|clear` and `commitStagedRevert` before prompt/promptAsync/shell/summarize
- Core `SessionV2.prompt` / `shell` also commit staged revert (App / protocol parity)

Manual TUI smoke (when exercising locally):

1. Undo last user turn → tail messages hide via `session.revert`
2. Redo with no later user → unrevert clears revert
3. Undo then send a new prompt → tail hard-deleted (commit); revert field cleared
4. Busy session → revert returns busy (execution.active)

App: undo uses `session.revert.stage`; next prompt commits via V2 `prompt` path above.
