#!/bin/sh
# Idempotent local setup: create the git-ignored .env from the sample, and append any keys
# that were added to the sample since (existing values are never overwritten).
set -eu
cd "$(dirname "$0")/.."

sample=infrastructure/docker/.env.example
env=infrastructure/docker/.env

[ -f "$env" ] || : > "$env"
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  key=${line%%=*}
  grep -q "^$key=" "$env" || printf '%s\n' "$line" >> "$env"
done < "$sample"

echo "ready: $env"
