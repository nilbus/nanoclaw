#!/usr/bin/env bash
# Agent stop hook: stage all changes, commit with a descriptive message, force-push.

set -e

log=${AGENT_GIT_SYNC_LOG:-/tmp/claw-git-commit-push.log}
exec >>"$log" 2>&1
printf '\nstarted %s cwd=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$PWD"

cd "$(git rev-parse --show-toplevel)" || exit 0

if [[ -z $(git status --porcelain) ]]; then
  echo "no changes to sync"
  exit 0
fi

# Build a short commit message from changed paths.
count=$(git status -s | wc -l | tr -d ' ')
if [[ $count -gt 5 ]]; then
  msg="sync agent changes ($count files)"
else
  files=$(git status -s | sed 's/^...//' | head -5 | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')
  msg="sync - $files"
fi

git add -A
git commit -m "$msg"
git push --force-with-lease
