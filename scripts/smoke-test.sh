#!/bin/sh
# Post-deploy / post-build smoke test.
# Usage: smoke-test.sh [user-service-url] [order-service-url] [notification-worker-url] [api-gateway-url] [keycloak-url]
# Checks user-service; with an order-service URL it also checks the order flow, including idempotent replay;
# with a notification-worker URL it also waits for the order's event to be processed (async path);
# with an api-gateway URL it also runs the whole flow again through the public entry point.
# Every business call carries a real Keycloak token (dev realm users, see security/keycloak/README.md);
# the keycloak-url defaults to http://localhost:8081. Tokens are never printed.
# Arguments are positional: each one needs the ones before it.
# Exits non-zero on the first failure. Safe to re-run (unique email and idempotency key per run).
set -eu

USER_URL="${1:-http://localhost:3001}"
ORDER_URL="${2:-}"
WORKER_URL="${3:-}"
GATEWAY_URL="${4:-}"
KEYCLOAK_URL="${5:-http://localhost:8081}"

id_of() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
# Password grant on the dev-only test client. Prints the access token; callers capture it, never echo it.
token_for() {
  curl -fsS -d grant_type=password -d client_id=platform-lab-dev -d "username=$1" -d "password=$1-fake-password" \
    "$KEYCLOAK_URL/realms/platform-lab/protocol/openid-connect/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}
ADMIN_TOKEN=$(token_for dev-admin)
[ -n "$ADMIN_TOKEN" ] || { echo "smoke FAILED: no token from Keycloak ($KEYCLOAK_URL); is the keycloak service up?" >&2; exit 1; }
# Authenticated helpers (admin token).
post() { curl -fsS -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" "$@"; }
get() { curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "$@"; }

curl -fsS "$USER_URL/health/live" >/dev/null
curl -fsS "$USER_URL/health/ready" >/dev/null

run="$(date +%s)-$$"
created=$(post -d "{\"email\":\"smoke-$run@example.com\",\"name\":\"Smoke\"}" "$USER_URL/v1/users")
user_id=$(printf '%s' "$created" | id_of)
[ -n "$user_id" ] || { echo "smoke FAILED: no id in create-user response: $created" >&2; exit 1; }
get "$USER_URL/v1/users/$user_id" >/dev/null
echo "smoke OK: user-service ($USER_URL)"

[ -n "$ORDER_URL" ] || exit 0

curl -fsS "$ORDER_URL/health/live" >/dev/null
curl -fsS "$ORDER_URL/health/ready" >/dev/null

order_body="{\"userId\":\"$user_id\",\"amount\":19.99,\"description\":\"smoke order\"}"
first=$(post -H "Idempotency-Key: smoke-$run" -d "$order_body" "$ORDER_URL/v1/orders")
order_id=$(printf '%s' "$first" | id_of)
[ -n "$order_id" ] || { echo "smoke FAILED: no id in create-order response: $first" >&2; exit 1; }

# Same key again must return the same order, not create a second one (FR-9).
second=$(post -H "Idempotency-Key: smoke-$run" -d "$order_body" "$ORDER_URL/v1/orders")
[ "$(printf '%s' "$second" | id_of)" = "$order_id" ] || { echo "smoke FAILED: idempotent replay returned a different order" >&2; exit 1; }

get "$ORDER_URL/v1/orders/$order_id" >/dev/null

# An unknown user must be rejected (422), proving the user-service lookup is really in the path.
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"userId":"00000000-0000-4000-8000-000000000000","amount":1,"description":"x"}' "$ORDER_URL/v1/orders")
[ "$code" = "422" ] || { echo "smoke FAILED: unknown user returned $code, expected 422" >&2; exit 1; }

echo "smoke OK: order-service ($ORDER_URL)"

[ -n "$WORKER_URL" ] || exit 0

curl -fsS "$WORKER_URL/health/live" >/dev/null
curl -fsS "$WORKER_URL/health/ready" >/dev/null

# The event is processed asynchronously: poll until the notification for our order shows up.
# The idempotent replay above must have produced exactly one event, hence exactly one notification.
attempt=0
while :; do
  found=$(get "$WORKER_URL/v1/notifications?orderId=$order_id")
  [ "$found" != "[]" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "smoke FAILED: no notification for order $order_id after 30s" >&2; exit 1; }
  sleep 1
done
count=$(printf '%s' "$found" | grep -o '"eventId"' | wc -l | tr -d ' ')
[ "$count" = "1" ] || { echo "smoke FAILED: expected 1 notification for order $order_id, found $count" >&2; exit 1; }

echo "smoke OK: notification-worker ($WORKER_URL)"

[ -n "$GATEWAY_URL" ] || exit 0

curl -fsS "$GATEWAY_URL/health/live" >/dev/null
curl -fsS "$GATEWAY_URL/health/ready" >/dev/null

# The caller's request id must be echoed back (and is forwarded to the backends for correlation).
echoed=$(curl -sS -D - -o /dev/null -H "authorization: Bearer $ADMIN_TOKEN" -H "x-request-id: smoke-gw-$run" "$GATEWAY_URL/v1/users/$user_id" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p')
[ "$echoed" = "smoke-gw-$run" ] || { echo "smoke FAILED: gateway did not echo x-request-id (got '$echoed')" >&2; exit 1; }

# The whole flow through the single entry point: user -> order -> asynchronous notification.
gw_user=$(post -d "{\"email\":\"smoke-gw-$run@example.com\",\"name\":\"Smoke GW\"}" "$GATEWAY_URL/v1/users" | id_of)
[ -n "$gw_user" ] || { echo "smoke FAILED: no user id through the gateway" >&2; exit 1; }
gw_order=$(post -H "Idempotency-Key: smoke-gw-$run" \
  -d "{\"userId\":\"$gw_user\",\"amount\":5,\"description\":\"smoke via gateway\"}" "$GATEWAY_URL/v1/orders" | id_of)
[ -n "$gw_order" ] || { echo "smoke FAILED: no order id through the gateway" >&2; exit 1; }

attempt=0
while [ "$(get "$GATEWAY_URL/v1/notifications?orderId=$gw_order")" = "[]" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "smoke FAILED: no notification for order $gw_order through the gateway after 30s" >&2; exit 1; }
  sleep 1
done

# Routes the gateway does not own must not leak through to a backend.
code=$(curl -sS -o /dev/null -w '%{http_code}' "$GATEWAY_URL/v1/unknown")
[ "$code" = "404" ] || { echo "smoke FAILED: unknown route returned $code through the gateway, expected 404" >&2; exit 1; }

echo "smoke OK: api-gateway ($GATEWAY_URL)"
