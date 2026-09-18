#!/bin/sh
# Post-deploy / post-build smoke test for user-service. Usage: smoke-test.sh [base-url]
# Exits non-zero on the first failure. Safe to re-run (uses a unique email per run).
set -eu

BASE_URL="${1:-http://localhost:3001}"

curl -fsS "$BASE_URL/health/live" >/dev/null
curl -fsS "$BASE_URL/health/ready" >/dev/null

email="smoke-$(date +%s)-$$@example.com"
created=$(curl -fsS -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"name\":\"Smoke\"}" "$BASE_URL/v1/users")
id=$(printf '%s' "$created" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$id" ] || { echo "smoke FAILED: no id in create response: $created" >&2; exit 1; }
curl -fsS "$BASE_URL/v1/users/$id" >/dev/null

echo "smoke OK ($BASE_URL)"
