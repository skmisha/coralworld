#!/usr/bin/env bash
# Runs every Phase 1 step in order; commits + pushes design-docs after each step.
set -uo pipefail
cd "$(dirname "$0")"
REPO=$(git rev-parse --show-toplevel)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
export NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1
commit() {
  git -C "$REPO" add -A
  git -C "$REPO" diff --cached --quiet && return
  git -C "$REPO" commit -qm "Phase 1: $1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AqsDq4ZPSnWsUu6PBwzacp"
  for d in 2 4 8 16 0; do git -C "$REPO" push -q -u origin "$BRANCH" && break; [ $d = 0 ] && echo "push failed"; sleep $d; done
}
step() { local name=$1 msg=$2; shift 2; echo "=== $name $(date -u +%T)"; if "$@"; then commit "$msg"; else echo "!!! $name failed"; commit "$msg (partial; step exited non-zero)"; fi; }
[ "${SKIP_DISCOVER:-0}" = 1 ] || step discover "crawl, routes.csv, content/he" node 01-discover.mjs
step assets      "asset download + manifest"            node 02-assets.mjs
step screenshots "screenshots 360-1440 portrait/landscape" node 03-screenshots.mjs
step integrations "integrations.md"                     node 04-integrations.mjs
step chat        "chat agent transcripts"               node 05-chat.mjs
step a11y        "axe + Lighthouse baseline"            node 06-a11y.mjs
echo "=== done $(date -u +%T)"
