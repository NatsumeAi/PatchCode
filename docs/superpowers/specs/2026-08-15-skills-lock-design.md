# Skills Lockfile + Quarantine Design (W8h)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-skills-lock.md`.

**Goal:** Skills stay discovery + `skill` tool + threat scan, plus **install provenance**. Not a Hermes hub / Grok marketplace.

**Proven:** `SkillV2` + `SkillDiscovery` (dir / URL / embedded). Load scans threats (`skill.ts`). No lockfile, no quarantine, URL pull is opportunistic.

## Rejected

- Shipping Hermes `optional-skills` dump.
- `/learn` auto-write to trusted skills without scan+trust (out of this program).
- Executing skill-bundled binaries at install (install is copy + hash only).

## Product

`~/.opencode/skills-lock.json`:

```
{ "skills": [ { "name", "source": "url"|"github"|"dir", "uri", "sha256", "installedAt", "state": "quarantine"|"active" } ] }
```

- `skill_install({ uri })`: fetch (https only, `Net.denyHost`), extract SKILL.md + listed files, hash, write under `~/.opencode/skills/<name>/`, state **quarantine**. **`file:` URIs are rejected.**
- `skill_trust({ name })`: scan again; if clean → `active` and add a `Skill.DirectorySource`.
- Quarantine skills: **not** in `SkillV2.list` / guidance; `skill` tool cannot load body.
- Project `.opencode/skills` still works as today but requires `Trust.Service` (W1) to be listed.
- `skill` tool on active: existing permission + scan.

HTTP: `POST /experimental/skills/install` same rules as memory (loopback/password).

## Anti-fake

1. Install https://example.invalid → fail, no lock row (or mock fetch).
2. Install via mocked https fixture: lock state quarantine; `SkillV2.list` omits name. `file:` URI is rejected (no lock row).
3. `skill` tool on quarantined name → error.
4. `skill_trust` after scan clean → list includes name; lock sha256 stable.
5. Threaty SKILL.md (`ignore previous instructions…` matching scan) cannot become active.
6. `rg skill_install packages/core/src/tool` + lock file writer; no marketplace client.
