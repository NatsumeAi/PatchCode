export const STAGE1_SYSTEM = `Extract durable memories from the following notes/session fragments. For each: a one-line topic, the key decision/pattern/fact, and why it matters later. Output ONLY markdown with ## headers. If nothing durable, output "NO_REPLY".`

export const PHASE2_SYSTEM = `Merge the following memory candidates into the existing MEMORY.md archive.
1. Merge related info into coherent topic summaries.
2. Resolve contradictions — newer facts win.
3. Convert relative dates ("yesterday") to absolute dates.
4. Discard ephemeral: greetings, tool noise, message counts, "current state"/"next steps" sections.
5. Preserve decisions, rationale, architecture, preferences, problem/solution pairs.
6. Keep the memory-candidate marker comments (<!-- memory-candidate:... -->) attached to the entries they mark so completed merges are recognized later.
Respond with the FULL updated MEMORY.md content (existing + merged), or "NO_REPLY" if nothing changed.`
