# Task tool discovery — prompt discipline

| Field | Audience | Content |
|---|---|---|
| Agent `description` | Parent model (via Task tool catalog) | When to use / can / cannot (1–2 lines) |
| Agent `capability` | Parent model (tag on catalog line) | `read-only` / `read-write` / `execute` / `all` |
| Agent `system` | Child model | Role, boundaries, output format |

Built-in `explore` sets `capability: "read-only"`. Primary `build` system includes short Task coaching.
