#!/bin/sh
# Secret scan (issue #5): the same commands locally and in CI (.github/workflows/secret-scan.yml).
#   sh security/secret-scan/scan.sh          scan the whole git history and fail on any leak
#   sh security/secret-scan/scan.sh canary   prove the config still detects a leak and accepts a placeholder
# Needs Docker only. Git Bash on Windows would rewrite the /repo mount path without the next line.
set -eu
export MSYS_NO_PATHCONV=1

IMAGE=zricethezav/gitleaks:v8.30.1 # pinned; bump on purpose (gitleaks adds rules between releases)
repo=$(cd "$(dirname "$0")/../.." && pwd)
config=/repo/security/secret-scan/gitleaks.toml

case "${1:-scan}" in
scan)
  # The mount is owned by another uid than the container's root, so git refuses it unless it is marked safe.
  docker run --rm -v "$repo:/repo:ro" --entrypoint sh "$IMAGE" -c \
    "git config --global --add safe.directory /repo && exec gitleaks git /repo --config $config --redact --no-banner -v"
  ;;
canary)
  # The lines are fed on stdin and the token is built from two pieces, so no real-looking secret is committed.
  leak="token=ghp_$(printf '%s%s' 'a1B2c3D4e5F6g7H8i9J0' 'k1L2m3N4o5P6q7R8')"
  ok='POSTGRES_PASSWORD=change-me-lab-only'
  scan_stdin() { printf '%s\n' "$1" | docker run --rm -i -v "$repo:/repo:ro" "$IMAGE" stdin --config "$config" --redact --no-banner; }
  if scan_stdin "$leak" >/dev/null 2>&1; then echo "canary: a leak-shaped token was NOT detected" >&2; exit 1; fi
  scan_stdin "$ok" >/dev/null 2>&1 || { echo "canary: a placeholder value was flagged" >&2; exit 1; }
  echo "canary: leak detected, placeholder accepted"
  ;;
*)
  echo "usage: $0 [scan|canary]" >&2
  exit 2
  ;;
esac
