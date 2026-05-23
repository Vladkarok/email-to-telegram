# Decisions

One line per durable decision, append-only. Reversals add a superseding line
pointing at the session that holds the new reasoning. Entries pre-dating the
memory system link a commit SHA or tag instead of a session file.

```
2026-05-22 · drizzle migrations re-baselined to a single squashed baseline; staging+prod reconciled in place (data preserved, no wipe) · commit a45111d
2026-05-22 · v2.5.0 shipped — delivery resilience (photo streaming, processing heartbeat) + engineering-review remediation · tag v2.5.0
2026-05-23 · agent memory system bootstrapped — repo-committed Markdown under docs/agent/, AGENTS.md canonical, cross-tool · sessions/2026-05-23-0047-memory-bootstrap.md
2026-05-23 · ECC reconciliation: convention over disable — the ECC SessionStart hook may fire (advisory only); AGENTS.md verbs supersede the colliding ECC skill names · sessions/2026-05-23-0101-ecc-reconciliation.md
2026-05-23 · pass3 vendor-doc review applied: baseline corrected (bootstrap commit touched non-memory paths, so it is the correct baseline), `--porcelain=v1` + explicit baseline-computation command added to protocol · sessions/2026-05-23-0112-pass3-hardening.md
2026-05-23 · protocol hardening: narrow `save session` staging (no `git add docs/agent` wholesale), repo-root normalization (`cd "$(git rev-parse --show-toplevel)"`), robust `sed`-based baseline parser in the acceptance test · sessions/2026-05-23-0153-protocol-hardening.md
2026-05-23 · code-vs-memory worktree split — drift gate uses `git status --porcelain=v1 --untracked-files=no --` with memory paths excluded; memory-in-flight dirtiness is advisory only and never triggers reconstruction · sessions/2026-05-23-0220-worktree-split.md
2026-05-23 · plan/AGENTS.md template alignment — STATE.md SHA placeholder shows the literal computation command; `DECISIONS.md` template added to AGENTS.md so both docs match · sessions/2026-05-23-0208-template-alignment.md
2026-05-23 · three-tier worktree rule — tracked code = drift gate, memory = advisory only, untracked = advisory with relevance check (source/test/config paths flagged as possible drift; scratch like tmp/ ignored). New acceptance Test 3c. · sessions/2026-05-23-0916-untracked-relevance.md
2026-05-23 · multi-session task plans formalized — `docs/agent/tasks/<slug>.md` holds the durable plan + checkbox state + per-step findings for work spanning sessions/compactions/limits; STATE.md "Now" links to it; new standing rule for compaction/limit resilience · sessions/2026-05-23-0924-multi-session-tasks.md
2026-05-23 · recovery rule reconciled with three-tier worktree rule — untracked files are surfaced but never trigger reconstruction (they don't exist in git); bootstrap step 2 now covers `docs/agent/tasks/` · sessions/2026-05-23-1119-recovery-rule-tasks-bootstrap.md
```
