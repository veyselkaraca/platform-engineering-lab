# Runbook: creating the Kubernetes Secrets for platform-lab

Applies to a fresh cluster/namespace before the first `helm install` of
`infrastructure/helm/platform-lab` (#7). No tooling in this repo generates or stores these Secrets —
that would either commit fake values that look real or build a secret manager nobody asked for
(AGENTS.md §7.12). An operator runs the commands below once per environment; use a real secret manager
(external-secrets, Vault, cloud KMS-backed Secret, …) in place of `kubectl create secret generic`
wherever one is available — the Secret name/key contract below is what `infrastructure/helm/platform-lab`
consumes either way.

## Prerequisite

The `platform-lab` Namespace exists (`kubectl apply -f infrastructure/kubernetes/namespaces/`) and
`infrastructure/helm/platform-data` (#12) is already installed — sections 1 and 2 both read from
Secrets CloudNativePG and the RabbitMQ Cluster Operator auto-generate for their own clusters.

## 1. Per-service database credentials

One Secret per service, key `DATABASE_URL`, matching what `infrastructure/docker/docker-compose.yml`
passes today (same connection-string shape, different host: the in-cluster Service is `postgres-rw`,
CloudNativePG's naming for its read-write endpoint, not a bare `postgres`). All four databases share the
one superuser CloudNativePG generates (`enableSuperuserAccess: true`,
`infrastructure/helm/platform-data/values.yaml`) — same single-admin-user model as
`docker-compose.yml`'s `POSTGRES_USER`, not a redesign:

```bash
PGPASSWORD=$(kubectl get secret postgres-superuser -n platform-lab -o jsonpath='{.data.password}' | base64 -d)

kubectl create secret generic user-service-db -n platform-lab \
  --from-literal=DATABASE_URL="postgres://postgres:${PGPASSWORD}@postgres-rw:5432/user_service"

kubectl create secret generic order-service-db -n platform-lab \
  --from-literal=DATABASE_URL="postgres://postgres:${PGPASSWORD}@postgres-rw:5432/order_service"

kubectl create secret generic notification-worker-db -n platform-lab \
  --from-literal=DATABASE_URL="postgres://postgres:${PGPASSWORD}@postgres-rw:5432/notification_worker"
```

The password is not "never reuse the compose `.env` value" advice here — it never came from this repo at
all; CloudNativePG generates it randomly per cluster. Rotating it is a CloudNativePG operation
(`kubectl cnpg` plugin or deleting `postgres-superuser` and letting the operator recreate it), not a
`kubectl create secret` edit — do that first, then redo the three commands above with the new password.

## 2. RabbitMQ credentials

One Secret shared by `order-service` and `notification-worker` (both reference it in
`infrastructure/helm/platform-lab/values.yaml`), key `RABBITMQ_URL`. The RabbitMQ Cluster Operator
auto-generates `rabbitmq-default-user` (username, password, host, port — AMQP 5672, already the
in-cluster Service `rabbitmq`) for its `RabbitmqCluster`, same pattern as PostgreSQL's superuser Secret
above:

```bash
RMQ_USER=$(kubectl get secret rabbitmq-default-user -n platform-lab -o jsonpath='{.data.username}' | base64 -d)
RMQ_PASS=$(kubectl get secret rabbitmq-default-user -n platform-lab -o jsonpath='{.data.password}' | base64 -d)

kubectl create secret generic platform-lab-rabbitmq -n platform-lab \
  --from-literal=RABBITMQ_URL="amqp://${RMQ_USER}:${RMQ_PASS}@rabbitmq:5672"
```

Rotation is a RabbitMQ Cluster Operator operation on `rabbitmq-default-user`, not a `kubectl create
secret` edit — same caveat as PostgreSQL's superuser password above.

## 3. Keycloak admin credentials

Deploying Keycloak to the cluster is #11, not yet built, so the exact Secret name isn't fixed yet — this
section documents the convention (mirrors `KEYCLOAK_ADMIN_USER`/`KEYCLOAK_ADMIN_PASSWORD` in
`infrastructure/docker/.env` and `security/keycloak/README.md`) so #11's chart has a name to target:

```bash
kubectl create secret generic keycloak-admin -n platform-lab \
  --from-literal=KEYCLOAK_ADMIN_USER="<admin-username>" \
  --from-literal=KEYCLOAK_ADMIN_PASSWORD="<admin-password>"
```

Confirm the actual name/keys against #11's chart once it lands — update this section then.

## Verify

```bash
kubectl get secrets -n platform-lab
```

Expect `user-service-db`, `order-service-db`, `notification-worker-db`, `platform-lab-rabbitmq` (plus
`keycloak-admin` once #11 exists) — each `Opaque`, `DATA` non-zero.

## Missing-secret failure mode

A Pod referencing a Secret that doesn't exist (or is missing the expected key) stays in
`CreateContainerConfigError`, visible via `kubectl get pods -n platform-lab` and its Events — never a
crash loop that hides the cause. Create the missing Secret, then `kubectl delete pod` (or wait for the
next rollout) to retry.

## Rotation

Update the Secret (`kubectl create secret generic ... --dry-run=client -o yaml | kubectl apply -f -` or
your secret manager's rotation flow), then `kubectl rollout restart deployment -n platform-lab` for the
services that read it — the chart's Deployments read `DATABASE_URL`/`RABBITMQ_URL` as env vars, not a
mounted volume, so a running Pod does not pick up a Secret update on its own.

## Related

- Secret name/key contract: `infrastructure/helm/platform-lab/values.yaml` (`secretEnv`)
- Decision record: [issue #8](https://github.com/veyselkaraca/platform-engineering-lab/issues/8)
- AGENTS.md §24 (Secrets Management)
