# Change history

- 2026-11-10 — Codex, Audrey's daily/event prosecution request: extended the
  existing GIT-FLEET tick with a local-only HULL scheduling path, SQLite attempt
  history and overlap leases, immutable input snapshots, bounded fixed argv,
  credential filtering, declared dependency fingerprints, held failures and
  explicit uncertain-run recovery. Added ten passing tests, including actual
  subprocess invocation and watchdog interruption. Original network/model tick
  and existing scheduled tasks remain available. Runtime acceptance and review
  receipts are recorded in schedules/local/OWNED-CHECKS.md.

- 2026-11-10 — Codex, review corrections: increased coverage to twelve scheduler
  tests; bound execution to retained input snapshots, fingerprinted declared
  downstream policies, refreshed per-job leases, retained interrupted work as
  uncertain, and added optional trusted local Git baseline packets with
  untracked-source refusal and concurrent-edit detection. First integrated
  prosecution failure is retained in the operational document.

- 2026-11-10 — Codex: final owned integration passed 78 tests with no provider
  calls. Registered the separate local-checks Windows task, verified its first
  exit code zero and Ready state, and retained exact nonsecret operator snapshots
  plus failure/success receipt metadata. Source implementation independently
  reviewed and twelve scheduler tests passed. No production release applied.

- 2026-11-10 — Codex review follow-up: refuse both standalone and joined-equals
  packet override syntax. Thirteen scheduler tests now pass; no existing task
  or policy was replaced. This enforces the documented immutable-input contract
  even where a downstream CLI currently ignores the joined spelling.
