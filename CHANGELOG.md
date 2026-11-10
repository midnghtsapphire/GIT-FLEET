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
