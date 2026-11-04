#!/usr/bin/env bash
# Commit whatever the fleet wrote and open a draft PR for Audrey. Agents never merge.
set -euo pipefail
label="${1:-run}"
if [ -z "$(git status --porcelain)" ]; then
  echo "No fleet changes to propose."
  exit 0
fi
branch="fleet/${label}-${GITHUB_RUN_ID:-local}"
git config user.name "${FLEET_GIT_NAME:-github-actions[bot]}"
git config user.email "${FLEET_GIT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
git switch -c "$branch"
node runner/fleet.mjs list --write >/dev/null
git add -A
git commit -m "fleet: ${label} (run ${GITHUB_RUN_ID:-local})"
git push -u origin "$branch"
gh pr create --draft --title "fleet: ${label} (run ${GITHUB_RUN_ID:-local})" \
  --body "Automated GIT-FLEET run. Read the run reports under \`runs/\` and any \`.incoming-*\` files before merging."
