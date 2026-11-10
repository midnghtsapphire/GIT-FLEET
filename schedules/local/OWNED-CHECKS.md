# Owned daily and event checks

2026-11-10, Codex, Audrey's request to continue revenue delivery and add daily
and event prosecution checks. This extends the existing fleet timer; HULL
remains the only command executor. The legacy model/whiteboard tick remains
available. The local-only entry point returns before loading its credentials,
settings, or network integrations.

## Context and feature contract

1. Context: revvel-standards #18347 and oaudrey #13 are merged. Four Railway
   releases remain staged; automatic approval review rejected apply. No live
   deployment or payment success is claimed. All 96 governance standards were
   read across the three assigned Codex reviewers before this implementation.
2. Feature: an operator can use the existing GIT-FLEET timer to invoke an
   explicitly configured HULL prosecution skill when a local packet changes
   or once per calendar day, without a provider, GitHub, or Airtable connection.
3. Dependencies: Node with node:sqlite (22.13+), Python with the existing HULL
   runtime, an operator-owned HULL policy and skill manifest, local review
   packet, receipt directory, and this repository. No external account.
4. Acceptance: real subprocess checks, duplicate tick exclusion, changed-packet
   execution, daily execution, failed-run receipts, refusal of invalid config,
   and explicit recovery after uncertain interrupted execution. An actual
   Windows task registration is a separate observed acceptance condition.
5. Scope: read-only/idempotent checks. No deployment, model calls, automatic
   code repair, board posting, PR creation, or GitHub-event transport. Local
   packet writes are the event source. GitHub remains optional storage.
6. Files: runner/fleet.mjs (early local-only routing), runner/local-jobs.mjs,
   runner/local-jobs.test.mjs, schedules/local/register-task.ps1, and this
   document. README and CHANGELOG receive additive notes.
7. Recovery: disable the separate `GIT-FLEET local checks` scheduled task.
   Preserve the journal and receipts. The original fleet task is untouched.
   An interrupted run is uncertain, never success; inspect HULL receipts and
   rerun with --retry-uncertain only for idempotent checks. No schema removal.

## Operator configuration

Use absolute paths. Keep configuration and packets outside public exports.
Each job contains an ID, watched packet, and the existing HULL invocation:

```json
{
  "version": 1,
  "timezone": "America/Denver",
  "state": "C:/operator/checks/journal.sqlite",
  "jobs": [{
    "id": "revenue-prosecution",
    "packet": "C:/operator/checks/review.json",
    "hull": {
      "python": "C:/owned/oaudrey/.venv/Scripts/python.exe",
      "entry": "C:/owned/oaudrey/scripts/local-hull.py",
      "skills": "C:/owned/revvel-standards/skills",
      "policy": "C:/operator/checks/hull-policy.json",
      "skill": "merge-prosecutor",
      "receipts": "C:/operator/checks/hull-receipts"
    }
  }]
}
```

The HULL policy binds the exact node executable, prosecutor CLI, local policy,
packet path, working directory, timeout, and manifest digest. A packet is data;
it cannot supply command arguments. Changing the packet, HULL policy, skill
manifest, or operator configuration changes the execution fingerprint.

Review correction: configure `watch` on each job with absolute downstream
prosecution-policy and source paths whose edits should also trigger checks.
Only declared dependencies are fingerprinted; this is not a whole-drive watcher.
Every run retains an exclusive immutable packet snapshot under `inputs/` beside
the journal and supplies that snapshot through HULL `--input`. A policy-level
`--packet` override is refused so it cannot bypass the fingerprinted input.

For delivery-source events, replace `packet` with an operator-owned `review`
object containing absolute `git` executable and `workspace` paths and a fixed
40-character `base` commit SHA. Each tick reads only local Git metadata/diff,
with external diff/text conversion disabled. The packet includes actual HEAD
and worktree-diff hash. A changed source tree triggers checks; another source
read after execution must match or the attempt becomes uncertain. New untracked
files fail closed until staged so they cannot be silently omitted. Ignored
runtime/private files stay outside the review. This is local review against a
chosen delivery baseline, not a claim of reviewing every remote PR or comment.

```powershell
node runner/fleet.mjs tick --local-only --jobs C:/operator/checks/jobs.json
powershell -File schedules/local/register-task.ps1 -LocalOnly -Jobs C:/operator/checks/jobs.json -Every 15
```

The journal uses SQLite transactions and leases to exclude overlapping ticks.
It retains every attempt. Successful unchanged jobs are skipped for the rest
of the configured local day. A failed fingerprint is held until its input
changes, the next local day, or an explicit --retry-failed invocation; this
prevents an unattended failure loop. Expired in-flight work is marked uncertain
and requires explicit --retry-uncertain. A crash can occur after external work
but before journal completion, so only idempotent checks belong in this mode.
The HULL command timeout is taken from its policy; the outer watchdog allows
additional cleanup time and preserves failure instead of printing provider
output. No raw stdout/stderr or environment values enter the journal.

Review correction: an outer watchdog or buffer interruption is **uncertain**,
because killing Python does not prove all HULL descendants stopped. Automated
replay is blocked even when the packet changes. Inspect process/receipt state
before explicit recovery. HULL's normal command timeout retains its own tree
cleanup. Lease timestamps are refreshed for each sequential job; successful
attempt selection uses journal insertion order rather than a mutable wall clock.

## Validation status

Implementation and runtime receipts are appended after verification. This
document does not itself establish that a task is registered or running.

2026-11-10 implementation validation: twelve scheduler tests passed, with a
strengthened untracked-source negative also run separately. Tests use actual
subprocess argv/environment observation, a real output-watchdog interruption,
SQLite overlap/restart state, and a real temporary Git repository changed
during execution. Node syntax, PowerShell parsing, scoped Markdown lint and
whitespace checks pass. Independent review corrections are retained above.

The first integrated invocation against the revenue checkout ran 51 tests
successfully but prosecution failed on a distinct-argparse-option false
positive. The failed HULL, prosecution and scheduler attempts are retained.
The detector regression/performance correction belongs to revvel-standards.
An updated end-to-end run is required before enabling the task.
