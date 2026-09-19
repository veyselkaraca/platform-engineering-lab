# Runbook: notification dead-letter queue

Applies to `notification.order-created.dlq` (see `messaging/rabbitmq/README.md`). Commands are for the local compose stack; in other environments run the same steps through the broker's management interface.

## Symptom

- Alert or check: DLQ depth > 0, or the worker logged `notification.dead_lettered`.
- Impact: those orders have no notification yet. Nothing else is blocked: healthy messages keep flowing.

## 1. What failed and why

Each dead-lettered message carries the reason and attempt count as headers, and the worker log has the same information with the correlation id.

```bash
docker compose -f infrastructure/docker/docker-compose.yml logs notification-worker --no-log-prefix | grep notification.dead_lettered
```

- `reason=permanent failure: ...` — the message is malformed. Retrying cannot help. Find the producer that sent it (the `correlationId` and `messageId` identify it) and fix the producer. Discard the message once understood.
- `reason=gave up after N attempts: ...` — a dependency failed for longer than the retry window (about `MAX_ATTEMPTS` x 10s). Typical cause: PostgreSQL unavailable. Fix the dependency, then replay.

Inspect messages without removing them (management UI on `http://localhost:15672`, queue `notification.order-created.dlq`, *Get messages* with **Nack message requeue true**).

## 2. Recover

After the cause is fixed:

```bash
sh scripts/replay-dlq.sh
```

The script moves every message from the DLQ back to the main queue through a one-off shovel that only removes a message after the main queue confirmed it, so nothing is lost if it is interrupted. Processing is idempotent (`UNIQUE(event_id)`), so replaying a message that was in fact already processed does not create a second notification.

Messages that still fail return to the DLQ after their retries. Repeated failures mean the cause is not fixed yet.

## 3. Verify recovery

```bash
docker compose -f infrastructure/docker/docker-compose.yml exec -T rabbitmq rabbitmqctl -q list_queues name messages
# needs a bearer token (an admin sees every notification); see security/keycloak/README.md for getting one
curl -s -H "authorization: Bearer $TOKEN" "http://localhost:3003/v1/notifications?orderId=<order id>"
```

The DLQ depth drops to the number of messages that are genuinely poison, and the notification for the order exists.

## Discarding a poison message

Only after the producer is fixed and the message is understood: purge it in the management UI (*Purge messages*) or `rabbitmqctl purge_queue notification.order-created.dlq` (this removes **all** messages in the queue, so replay the good ones first).

## Related

- This procedure (retry, dead-lettering with reason headers, `scripts/replay-dlq.sh`) is exercised against the real stack by `tests/chaos/broker-failures.chaos.mjs`.
- Worker README: `services/notification-worker/README.md`
- Failure scenarios verified for this component: `docs/features/order-notification/TEST-PLAN.md`
