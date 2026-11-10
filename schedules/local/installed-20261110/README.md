# Operator snapshot — 10 November 2026

These are actual nonsecret configurations used on Audrey's Windows computer.
They preserve the reviewed exact argv, manifest digest, private runtime paths,
local Git baseline and watched HULL/prosecution dependencies. They contain no
provider key, account token, password or private signing key.

- jobs.json: existing fleet tick's local-only scheduling configuration.
- hull-policy.json: HULL's command/environment/workspace policy.
- prosecution-policy.json: exact local Node checks and receipt directory.
- verification.json: final HULL/prosecution result and actual task observation.

Absolute paths deliberately identify this machine. Copying these snapshots to
another machine does not provision access or authorize new commands; configure
its owned paths explicitly. Live configuration remains under the review path
recorded in jobs.json and the installed task. Preserve earlier snapshots and
receipts when changing policy. No binary journal or raw credential-bearing log
is included here; retained receipt metadata includes output hashes.
