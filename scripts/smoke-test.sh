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
# Authenticated helpers: *_as takes the token first; post/get use the admin token.
post_as() { t=$1; shift; curl -fsS -H 'content-type: application/json' -H "authorization: Bearer $t" "$@"; }
get_as() { t=$1; shift; curl -fsS -H "authorization: Bearer $t" "$@"; }
post() { post_as "$ADMIN_TOKEN" "$@"; }
get() { get_as "$ADMIN_TOKEN" "$@"; }

curl -fsS "$USER_URL/health/live" >/dev/null
curl -fsS "$USER_URL/health/ready" >/dev/null

run="$(date +%s)-$$"

# The realm's fixed dev users (security/keycloak/realm/platform-lab-dev.json): the token `sub` is the userId.
CUSTOMER_ID=c0ffee00-0000-4000-8000-000000000001
ADMIN_ID=c0ffee00-0000-4000-8000-000000000002
OTHER_ID=c0ffee00-0000-4000-8000-000000000003
CUSTOMER_TOKEN=$(token_for dev-customer)
OTHER_TOKEN=$(token_for dev-other)
[ -n "$CUSTOMER_TOKEN" ] && [ -n "$OTHER_TOKEN" ] || { echo "smoke FAILED: no customer tokens from Keycloak" >&2; exit 1; }
user_id=$CUSTOMER_ID
status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }
expect() { [ "$1" = "$2" ] || { echo "smoke FAILED: $3: got $1, expected $2" >&2; exit 1; }; }

# Users live in Keycloak; an admin registers the matching record. Re-runs answer 409, which is fine.
code=$(status -X POST -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"id\":\"$CUSTOMER_ID\",\"email\":\"dev-customer@example.invalid\",\"name\":\"Dev Customer\"}" "$USER_URL/v1/users")
case "$code" in 201|409) ;; *) echo "smoke FAILED: registering the customer returned $code" >&2; exit 1 ;; esac
get "$USER_URL/v1/users/$user_id" >/dev/null

# Authentication and authorization (docs/features/identity-keycloak).
expect "$(status "$USER_URL/v1/users/$user_id")" 401 "user-service without a token"
sig=${CUSTOMER_TOKEN##*.}
case "$sig" in A*) flip=B ;; *) flip=A ;; esac
tampered="${CUSTOMER_TOKEN%.*}.$flip${sig#?}"
expect "$(status -H "authorization: Bearer $tampered" "$USER_URL/v1/users/$user_id")" 401 "user-service with a tampered token"
expect "$(status -H "authorization: Bearer $CUSTOMER_TOKEN" "$USER_URL/v1/users/$user_id")" 200 "customer reading themself"
expect "$(status -H "authorization: Bearer $CUSTOMER_TOKEN" "$USER_URL/v1/users/$ADMIN_ID")" 403 "customer reading another user"
expect "$(status -X POST -H 'content-type: application/json' -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -d "{\"id\":\"$ADMIN_ID\",\"email\":\"x@example.invalid\",\"name\":\"X\"}" "$USER_URL/v1/users")" 403 "customer creating a user"
echo "smoke OK: user-service ($USER_URL)"

[ -n "$ORDER_URL" ] || exit 0

curl -fsS "$ORDER_URL/health/live" >/dev/null
curl -fsS "$ORDER_URL/health/ready" >/dev/null

order_body="{\"userId\":\"$user_id\",\"amount\":19.99,\"description\":\"smoke order\"}"
first=$(post_as "$CUSTOMER_TOKEN" -H "Idempotency-Key: smoke-$run" -d "$order_body" "$ORDER_URL/v1/orders")
order_id=$(printf '%s' "$first" | id_of)
[ -n "$order_id" ] || { echo "smoke FAILED: no id in create-order response: $first" >&2; exit 1; }

# Same key again must return the same order, not create a second one (FR-9).
second=$(post_as "$CUSTOMER_TOKEN" -H "Idempotency-Key: smoke-$run" -d "$order_body" "$ORDER_URL/v1/orders")
[ "$(printf '%s' "$second" | id_of)" = "$order_id" ] || { echo "smoke FAILED: idempotent replay returned a different order" >&2; exit 1; }

get_as "$CUSTOMER_TOKEN" "$ORDER_URL/v1/orders/$order_id" >/dev/null

# Authorization on orders: no token, ordering for someone else, reading someone else's order, replaying their key.
expect "$(status -H 'content-type: application/json' -d "$order_body" "$ORDER_URL/v1/orders")" 401 "order-service without a token"
expect "$(status -H 'content-type: application/json' -H "authorization: Bearer $CUSTOMER_TOKEN"   -d "{\"userId\":\"$OTHER_ID\",\"amount\":1,\"description\":\"x\"}" "$ORDER_URL/v1/orders")" 403 "customer ordering for another user"
expect "$(status -H "authorization: Bearer $OTHER_TOKEN" "$ORDER_URL/v1/orders/$order_id")" 404 "another customer reading the order"
expect "$(status -H 'content-type: application/json' -H "authorization: Bearer $OTHER_TOKEN" -H "Idempotency-Key: smoke-$run"   -d "{\"userId\":\"$OTHER_ID\",\"amount\":19.99,\"description\":\"smoke order\"}" "$ORDER_URL/v1/orders")" 409 "another customer replaying the idempotency key"
expect "$(status -H "authorization: Bearer $ADMIN_TOKEN" "$ORDER_URL/v1/orders/$order_id")" 200 "admin reading the order"

# An unknown user must be rejected (422), proving the user-service lookup is really in the path.
expect "$(status -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userId":"00000000-0000-4000-8000-000000000000","amount":1,"description":"x"}' "$ORDER_URL/v1/orders")" 422 "unknown user"

echo "smoke OK: order-service ($ORDER_URL)"

[ -n "$WORKER_URL" ] || exit 0

curl -fsS "$WORKER_URL/health/live" >/dev/null
curl -fsS "$WORKER_URL/health/ready" >/dev/null

# The event is processed asynchronously: poll until the notification for our order shows up.
# The idempotent replay above must have produced exactly one event, hence exactly one notification.
attempt=0
while :; do
  found=$(get_as "$CUSTOMER_TOKEN" "$WORKER_URL/v1/notifications?orderId=$order_id")
  [ "$found" != "[]" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "smoke FAILED: no notification for order $order_id after 30s" >&2; exit 1; }
  sleep 1
done
count=$(printf '%s' "$found" | grep -o '"eventId"' | wc -l | tr -d ' ')
[ "$count" = "1" ] || { echo "smoke FAILED: expected 1 notification for order $order_id, found $count" >&2; exit 1; }

# Authorization on notifications: no token is refused; another customer sees nothing for this order, an admin sees it.
expect "$(status "$WORKER_URL/v1/notifications?orderId=$order_id")" 401 "notification-worker without a token"
[ "$(get_as "$OTHER_TOKEN" "$WORKER_URL/v1/notifications?orderId=$order_id")" = "[]" ] || { echo "smoke FAILED: another customer can see the notification" >&2; exit 1; }
[ "$(get "$WORKER_URL/v1/notifications?orderId=$order_id" | grep -o '"eventId"' | wc -l | tr -d ' ')" = "1" ] || { echo "smoke FAILED: admin cannot see the notification" >&2; exit 1; }

echo "smoke OK: notification-worker ($WORKER_URL)"

[ -n "$GATEWAY_URL" ] || exit 0

curl -fsS "$GATEWAY_URL/health/live" >/dev/null
curl -fsS "$GATEWAY_URL/health/ready" >/dev/null

# The caller's request id must be echoed back (and is forwarded to the backends for correlation).
echoed=$(curl -sS -D - -o /dev/null -H "authorization: Bearer $ADMIN_TOKEN" -H "x-request-id: smoke-gw-$run" "$GATEWAY_URL/v1/users/$user_id" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p')
[ "$echoed" = "smoke-gw-$run" ] || { echo "smoke FAILED: gateway did not echo x-request-id (got '$echoed')" >&2; exit 1; }

# The whole flow through the single entry point: user -> order -> asynchronous notification.
gw_user=$CUSTOMER_ID
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
