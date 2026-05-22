# Decisions

One line per durable decision, append-only. Reversals add a superseding line
pointing at the session that holds the new reasoning. Entries pre-dating the
memory system link a commit SHA or tag instead of a session file.

```
2026-05-22 · drizzle migrations re-baselined to a single squashed baseline; staging+prod reconciled in place (data preserved, no wipe) · commit a45111d
2026-05-22 · v2.5.0 shipped — delivery resilience (photo streaming, processing heartbeat) + engineering-review remediation · tag v2.5.0
2026-05-23 · agent memory system bootstrapped — repo-committed Markdown under docs/agent/, AGENTS.md canonical, cross-tool · sessions/2026-05-23-0047-memory-bootstrap.md
2026-05-23 · ECC reconciliation: convention over disable — the ECC SessionStart hook may fire (advisory only); AGENTS.md verbs supersede the colliding ECC skill names · sessions/2026-05-23-0101-ecc-reconciliation.md
```
