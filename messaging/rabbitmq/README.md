# RabbitMQ

Topology is declared in `definitions/definitions.json`, so it is version-controlled and identical in every environment. Locally it is imported by the one-shot `rabbitmq-init` compose service (`rabbitmqadmin definitions import`, idempotent) once the broker is healthy. Credentials are not part of the definitions; the default user comes from environment variables at runtime.

Why not `load_definitions` at boot: when it is set, RabbitMQ skips creating the default user from `RABBITMQ_DEFAULT_USER`, and the only alternative is committing a password hash to the repo.

```text
orders (topic) --order.created--> notification.order-created
                                        | consumer nacks (requeue=false)
                                        v
                                  orders.retry (direct) --> notification.order-created.retry (TTL 10s)
                                                                  | TTL expires
                                                                  v
                                                            orders.requeue (direct) --> notification.order-created

after MAX attempts the consumer publishes to notification.order-created.dlq (manual recovery)
```

| Object | Purpose |
|---|---|
| `orders` | Event exchange; order-service publishes here (`order.created`). |
| `notification.order-created` | notification-worker's queue. Failures dead-letter to the retry path. |
| `...retry` | Delay buffer: messages wait 10s, then return to the main queue. |
| `...dlq` | Poison messages after bounded retries; alert on depth > 0. |

Attempt counting and the move to the DLQ are the consumer's responsibility (notification-worker, next slice). Unroutable publishes are not flagged today; the publisher does not use `mandatory`.

Failure/rollback: removing an object is a definitions change plus a broker restart with an empty data volume in dev; in shared environments delete the queue only after it is empty.
