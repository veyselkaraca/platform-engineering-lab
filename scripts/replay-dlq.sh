#!/bin/sh
# Moves every message currently in the notification dead-letter queue back to the main queue
# (local compose stack). See docs/operations/runbooks/notification-dlq.md.
#
# Loss-safe: a one-off dynamic shovel with ack-mode on-confirm removes a message from the DLQ only after the
# main queue confirmed it, and deletes itself after transferring the queue length it saw at start.
# Fix the root cause first: messages that fail again return to the DLQ after their retries.
set -eu

cd "$(dirname "$0")/../infrastructure/docker"

QUEUE=notification.order-created
mq() { docker compose exec -T rabbitmq "$@"; }
# Credentials come from the container's own environment, never from this host's command line.
admin() { mq sh -c 'rabbitmqadmin --non-interactive --username "$RABBITMQ_DEFAULT_USER" --password "$RABBITMQ_DEFAULT_PASS" "$@"' _ "$@"; }
depth() { mq rabbitmqctl -q list_queues name messages | awk -v q="$1" '$1==q{print $2}'; }

before=$(depth "$QUEUE.dlq")
if [ "${before:-0}" = "0" ]; then
  echo "DLQ is empty, nothing to replay"
  exit 0
fi

name="dlq-replay-$(date +%s)"
admin parameters set --component shovel --name "$name" --value "{
  \"src-protocol\": \"amqp091\", \"src-uri\": \"amqp://\", \"src-queue\": \"$QUEUE.dlq\",
  \"src-delete-after\": \"queue-length\",
  \"dest-protocol\": \"amqp091\", \"dest-uri\": \"amqp://\", \"dest-queue\": \"$QUEUE\",
  \"ack-mode\": \"on-confirm\"
}"

# The shovel removes itself when done.
i=0
while mq rabbitmqctl -q list_parameters | grep -q "$name"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "replay FAILED: shovel $name still present after 30s" >&2; exit 1; }
  sleep 1
done

echo "replayed $before message(s) from $QUEUE.dlq to $QUEUE (DLQ depth now: $(depth "$QUEUE.dlq"))"
