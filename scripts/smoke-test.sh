#!/bin/sh
# Post-deploy / post-build smoke test.
# Usage: smoke-test.sh [user-service-url] [order-service-url] [notification-worker-url]
# Checks user-service; with an order-service URL it also checks the order flow, including idempotent replay;
# with a notification-worker URL it also waits for the order's event to be processed (async path).
# Exits non-zero on the first failure. Safe to re-run (unique email and idempotency key per run).
set -eu

USER_URL="${1:-http://localhost:3001}"
ORDER_URL="${2:-}"
WORKER_URL="${3:-}"

id_of() { sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
post() { curl -fsS -H 'content-type: application/json' "$@"; }

curl -fsS "$USER_URL/health/live" >/dev/null
curl -fsS "$USER_URL/health/ready" >/dev/null

run="$(date +%s)-$$"
created=$(post -d "{\"email\":\"smoke-$run@example.com\",\"name\":\"Smoke\"}" "$USER_URL/v1/users")
user_id=$(printf '%s' "$created" | id_of)
[ -n "$user_id" ] || { echo "smoke FAILED: no id in create-user response: $created" >&2; exit 1; }
curl -fsS "$USER_URL/v1/users/$user_id" >/dev/null
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

curl -fsS "$ORDER_URL/v1/orders/$order_id" >/dev/null

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
  found=$(curl -fsS "$WORKER_URL/v1/notifications?orderId=$order_id")
  [ "$found" != "[]" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "smoke FAILED: no notification for order $order_id after 30s" >&2; exit 1; }
  sleep 1
done
count=$(printf '%s' "$found" | grep -o '"eventId"' | wc -l | tr -d ' ')
[ "$count" = "1" ] || { echo "smoke FAILED: expected 1 notification for order $order_id, found $count" >&2; exit 1; }

echo "smoke OK: notification-worker ($WORKER_URL)"
