#!/bin/sh
# Chaos check: how the platform behaves while Keycloak is down (docs/features/identity-keycloak/TEST-PLAN.md).
# Needs the compose stack running. Stops Keycloak, and always starts it again on exit.
#   warm cache : a service that already fetched the keys keeps accepting valid tokens
#   cold start : a service restarted while Keycloak is down stays live and ready but fails closed (503), never open
#   recovery   : once Keycloak is back the same service accepts tokens again, without a restart
#   expiry     : with a short key-cache TTL (5 s), a warm service turns to 503 once the cache expires while Keycloak is
#                still down; the default TTL (1 h) is restored afterwards
# Usage: keycloak-outage.sh [user-service-url] [keycloak-url]
set -eu
cd "$(dirname "$0")/../.."

USER_URL="${1:-http://localhost:3001}"
KEYCLOAK_URL="${2:-http://localhost:8081}"
COMPOSE="docker compose -f infrastructure/docker/docker-compose.yml"

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$1" = "$2" ] || { echo "chaos FAILED: $3: got $1, expected $2" >&2; exit 1; }; }
wait_for() { # <description> <url> <status>
  n=0
  until [ "$(status "$2" || true)" = "$3" ]; do
    n=$((n + 1))
    [ "$n" -lt 60 ] || { echo "chaos FAILED: timed out waiting for $1" >&2; exit 1; }
    sleep 2
  done
}

# Always leave the stack as found: Keycloak running, user-service on its default key-cache TTL.
trap '$COMPOSE start keycloak >/dev/null 2>&1 || true; $COMPOSE up -d --no-deps --wait user-service >/dev/null 2>&1 || true' EXIT

fresh_token() {
  curl -fsS -d grant_type=password -d client_id=platform-lab-dev -d username=dev-admin -d password=dev-admin-fake-password \
    "$KEYCLOAK_URL/realms/platform-lab/protocol/openid-connect/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

TOKEN=$(fresh_token)
[ -n "$TOKEN" ] || { echo "chaos FAILED: no token (is the stack up?)" >&2; exit 1; }
ADMIN_ID=c0ffee00-0000-4000-8000-000000000002
call() { status -H "authorization: Bearer $TOKEN" "$USER_URL/v1/users/$ADMIN_ID"; }

# The record may not exist (404): what matters is that the request got past authentication (not 401/503).
warm=$(call)
case "$warm" in 200|404) ;; *) echo "chaos FAILED: baseline call returned $warm" >&2; exit 1 ;; esac

echo "chaos: stopping keycloak"
$COMPOSE stop keycloak >/dev/null

expect "$(call)" "$warm" "warm cache while Keycloak is down"
echo "chaos OK: warm cache keeps working"

echo "chaos: restarting user-service with keycloak down (cold cache)"
$COMPOSE restart user-service >/dev/null
wait_for "user-service liveness" "$USER_URL/health/live" 200
wait_for "user-service readiness (must not depend on Keycloak)" "$USER_URL/health/ready" 200
expect "$(call)" 503 "cold start with Keycloak down must fail closed"
expect "$(status "$USER_URL/v1/users/$ADMIN_ID")" 401 "no token is still 401, not 503"
echo "chaos OK: cold start is live, ready and closed"

echo "chaos: starting keycloak"
$COMPOSE start keycloak >/dev/null
wait_for "keycloak" "$KEYCLOAK_URL/realms/platform-lab" 200
n=0
until [ "$(call)" = "$warm" ]; do
  n=$((n + 1))
  [ "$n" -lt 30 ] || { echo "chaos FAILED: user-service did not recover after Keycloak returned" >&2; exit 1; }
  sleep 2
done
echo "chaos OK: recovered without restarting user-service"

echo "chaos: key-cache expiry (user-service recreated with AUTH_JWKS_CACHE_SECONDS=5)"
AUTH_JWKS_CACHE_SECONDS=5 $COMPOSE up -d --no-deps --wait user-service >/dev/null
TOKEN=$(fresh_token)
expect "$(call)" "$warm" "warm call before the outage (short TTL)"
$COMPOSE stop keycloak >/dev/null
expect "$(call)" "$warm" "still inside the 5 s cache window"
sleep 7
expect "$(call)" 503 "after the cache expired with Keycloak still down"
expect "$(status "$USER_URL/health/ready")" 200 "readiness after cache expiry"
echo "chaos OK: expired cache fails closed, health stays green"
