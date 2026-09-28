# platform-data (in-cluster PostgreSQL, Redis, RabbitMQ)

Built for [#12](https://github.com/veyselkaraca/platform-engineering-lab/issues/12) ("Run PostgreSQL,
Redis and RabbitMQ in the cluster"). One source of truth per resource type
(`infrastructure/kubernetes/README.md`): the four application services and their own
Deployment/Service/ConfigMap live in `infrastructure/helm/platform-lab` (#7); this chart owns only the
stateful dependencies, kept separate so an operator's CRDs/lifecycle never couple to the app chart.

## Decision (#12-1): operator/managed chart vs. plain Deployment, per dependency

They don't have to share an answer (issue #12's own requirement):

| Dependency | Decision | Status | Reason |
|---|---|---|---|
| Redis | Plain Deployment + Service, no operator, no Bitnami chart | **Accepted, implemented** | Single instance, no persistence requirement (#12-5; AGENTS.md §21 — Redis is never authoritative), so there is no failover/PVC/upgrade behavior worth an operator's CRD/controller overhead. Bitnami's free charts/images are frozen since Aug 2025 (moved to unsupported `bitnamilegacy`), ruling out `bitnami/redis` even as the "default" option (issue #12 comment, verified 2026-09-27). Persistence is disabled outright (`--save "" --appendonly no`) rather than left at the image's default, so a restart never leaves a stale save file behind and order-service's existing fallback-to-user-service path (ADR-001) stays the only recovery story. |
| PostgreSQL | CloudNativePG operator | **Accepted, implemented** | Encodes PVC, failover and minor-version upgrade handling a bespoke StatefulSet would reinvent (AGENTS.md §7.12). Operational cost: one more CRD/controller (`cnpg-system` namespace). Confirmed conflict, now fixed: CNPG's default Pod/PVC labels are `cnpg.io/cluster: <name>`, never `app.kubernetes.io/name` — the operator does not propagate labels from the `Cluster`'s own metadata unless separately configured to inherit them (extra machinery not worth adding just to satisfy a naming convention). `infrastructure/kubernetes/policies/40-allow-egress-to-postgres.yaml` now selects on `cnpg.io/cluster: postgres` instead. `enableSuperuserAccess: true` so `db-init` (#12-3) and every service's `DATABASE_URL` Secret share one admin identity across the four databases — same single-user model `docker-compose.yml` already uses, not a redesign. |
| RabbitMQ | RabbitMQ Cluster Operator, pinned to v2.19.2 | **Accepted, implemented** | Installs from a GitHub release manifest, not a Helm repo (issue #12 comment). Confirmed: naming the `RabbitmqCluster` resource `rabbitmq` makes the operator's default labels (`app.kubernetes.io/name: rabbitmq`) satisfy `infrastructure/kubernetes/policies/42-allow-egress-to-rabbitmq.yaml`'s assumption exactly — no policy change needed for that path, unlike Postgres. Pinned below latest (v2.23.0) deliberately, not by default drift — see the version note underneath this table. |

Not evaluated: the RabbitMQ Messaging Topology Operator (a fourth operator that would let `definitions.json`'s exchanges/queues/bindings be declared as their own CRDs instead of the `rabbitmqadmin` Job) — #12's own design note says reuse the existing script as a Job, and a fourth operator to declare three exchanges and three queues is exactly the complexity AGENTS.md §7.12 asks to justify first.

### Version note: RabbitMQ Cluster Operator v2.19.2, not latest

Checked the actual release manifests before picking a version: starting at v2.20.0, `cluster-operator.yml`
adds a `MutatingWebhookConfiguration`/`ValidatingWebhookConfiguration` whose TLS certificate is issued by
a cert-manager `Certificate` resource — cert-manager becomes a **second** cluster-wide operator this lab
would need only to install the first one, for a single small `RabbitmqCluster` CR that does not need
admission-webhook validation to be correct. v2.19.2 (the last release before this) has no cert-manager
reference and no webhook at all — confirmed by diffing the two manifests directly, not by assumption.
Revisit this pin if a future dependency actually needs cert-manager for something else, at which point
the operational cost is already paid and upgrading the RabbitMQ operator past v2.20 stops being a
standalone burden.

## Decision (#12-6): backup/restore

| Dependency | Decision | Status |
|---|---|---|
| PostgreSQL | Deferred to a follow-up issue | CloudNativePG's backup story (Barman Cloud plugin) needs an S3-compatible object-storage target this lab does not provision anywhere else; adding one just for this would be new infrastructure without the rest of the platform needing it (AGENTS.md §7.12). This is the "not implemented yet, tracked as a follow-up issue" case #12-6 explicitly allows for one of the two dependencies. |
| RabbitMQ | The topology already is backed up; message data deliberately is not | `messaging/rabbitmq/definitions/definitions.json` is version-controlled and is exactly what `rabbitmq-init` replays on every apply (#12-4) — recreating the exchanges/queues/bindings from source control on a fresh cluster **is** the restore procedure, no separate backup mechanism needed for topology. In-flight messages are not backed up: RabbitMQ here is best-effort async delivery with retry+DLQ (ADR-001's own stated limitation), not a durable ledger, so message loss on total cluster loss is an accepted characteristic of the existing design, not a new gap #12 introduces. |

Not a silent gap either way — both rows are a stated decision, not an omission.

## Redis

```bash
helm lint infrastructure/helm/platform-data
helm template platform-data infrastructure/helm/platform-data
helm upgrade --install platform-data infrastructure/helm/platform-data -n platform-lab
```

Targets the same `platform-lab` Namespace as the application chart
(`infrastructure/kubernetes/namespaces/`, #8) — apply that first, same as
`infrastructure/helm/platform-lab`. `order-service` reaches it at `redis://redis:6379`, already the
default in `infrastructure/helm/platform-lab/values.yaml`.
`infrastructure/kubernetes/policies/41-allow-egress-to-redis.yaml` (#9) selects
`app.kubernetes.io/name: redis` on port 6379, matching this Service/Deployment's labels exactly — apply
the policies (`infrastructure/kubernetes/policies/`) after this release, same ordering note as
`infrastructure/kubernetes/README.md`'s "Apply order" (the Ingress rule's selector needs the Redis Pod
to already exist).

No Secret, ConfigMap or PVC: Redis takes no credentials and, with persistence disabled, no config to
externalize and no volume to recover.

Rollback: `helm rollback platform-data <revision>` — stateless, so there is nothing to restore beyond
the Deployment spec itself.

## PostgreSQL

Requires the CloudNativePG operator installed cluster-wide first (`infrastructure/kubernetes/README.md`
"one-time per-cluster bootstrap"). Then the same install command as Redis (`helm upgrade --install
platform-data infrastructure/helm/platform-data -n platform-lab`) also creates:

- A `Cluster` (name `postgres`, 1 instance — matching compose's single Postgres container; #12's own
  scope note says single-node is enough for the lab) — CNPG then creates the `postgres-1` Pod, its PVC,
  and the `postgres-rw`/`-ro`/`-r` Services and the `postgres-superuser` Secret on its own.
- A `db-init` Job (#12-3): a `wait-for-postgres` initContainer polls `pg_isready` against `postgres-rw`
  (Kubernetes Jobs have no `depends_on: condition: service_healthy` equivalent, so the wait has to live
  inside the Job itself), then the main container runs `files/init-databases.sh` — a byte-for-byte copy
  of `infrastructure/docker/config/postgres/init-databases.sh` (Helm's `.Files.Get` can only read inside
  the chart, so a duplicate is unavoidable; keep the two in sync by hand if the script changes) — to
  create `user_service`, `order_service`, `notification_worker` and `keycloak`, exactly what
  `docker-compose.yml`'s `db-init` creates today (ADR-001: one database per service).
- The Job runs as `helm.sh/hook: post-install,post-upgrade`, **not** `pre-install` as #12's Operations
  section originally suggested: a pre-install hook must finish before Helm creates anything else in the
  release, so a Job waiting on the `Cluster` this same chart defines would deadlock on the very first
  `helm install` — the Cluster it is polling for would never get created. `hook-delete-policy:
  before-hook-creation,hook-succeeded` re-runs it fresh on every `helm upgrade`, per #12-3's "idempotent
  on every apply."
- Per-service `DATABASE_URL` Secrets are still provisioned manually
  (`docs/operations/runbooks/kubernetes-secrets.md`), now against the real `postgres-rw` host and the
  operator-generated superuser password instead of a placeholder.

## RabbitMQ

Requires the RabbitMQ Cluster Operator installed cluster-wide first
(`infrastructure/kubernetes/README.md` "one-time per-cluster bootstrap", pinned version — see the
decision above). The same install command also creates:

- A `RabbitmqCluster` (name `rabbitmq`, 1 replica — matching compose's single broker; #12's own scope
  note says single-node/mirrored is enough for the lab) — the operator then creates the
  `rabbitmq-server-0` StatefulSet Pod, its PVC, the `rabbitmq`/`rabbitmq-nodes` Services and the
  `rabbitmq-default-user` Secret on its own. No `additionalPlugins` set: `rabbitmq_management` is
  already one of the operator's own "essential" always-on plugins (needed for `rabbitmqadmin` below),
  and `rabbitmq_shovel` is deliberately left out — it is a docker-compose-only debugging aid for
  `scripts/replay-dlq.sh`, which runs against compose, not the cluster (see
  `infrastructure/kubernetes/policies/42-allow-egress-to-rabbitmq.yaml`).
- A `rabbitmq-init` Job (#12-4): a `wait-for-rabbitmq` initContainer polls `rabbitmqadmin ... list
  vhosts` against the management API (same wait-has-to-live-in-the-Job reasoning as `db-init`), then the
  main container runs the exact same `rabbitmqadmin definitions import --file` compose's `rabbitmq-init`
  already runs, against `files/definitions.json` — a byte-for-byte copy of
  `messaging/rabbitmq/definitions/definitions.json` (same Helm `.Files` constraint as
  `files/init-databases.sh`; keep the two in sync by hand if the topology changes).
- Same `post-install,post-upgrade` hook reasoning as `db-init`, same idempotency guarantee.
- `docs/operations/runbooks/kubernetes-secrets.md`'s `platform-lab-rabbitmq` Secret is built from
  `rabbitmq-default-user`'s auto-generated username/password against the real `rabbitmq` Service host,
  same pattern as PostgreSQL.

## A real gap `helm template` could not have caught: init Jobs vs. enforced NetworkPolicy

`db-init` and `rabbitmq-init` re-run on **every** `helm upgrade` (`hook-delete-policy:
before-hook-creation,hook-succeeded`, per #12-3/#12-4's "idempotent on every apply"), but
`infrastructure/kubernetes/README.md`'s documented "Apply order" only guarantees the *first* `helm
install` happens before `policies/` (#9) is applied — every later `helm upgrade` runs with default-deny
already enforced. Tested this directly (kind + Calico, both operators, policies applied, then `helm
upgrade` to force the Jobs to re-run): `db-init` hung, `pg_isready` logging `no response` on every
retry — the exact silent-network-block symptom `infrastructure/kubernetes/README.md`'s diagnosis guide
already describes, not an application error. Neither `postgres-db-init` nor `rabbitmq-init` were in
`40`/`42`'s caller allow-lists (those were written for the *application* services, before this chart's
own Jobs existed). Fixed in both files: `40-allow-egress-to-postgres.yaml` adds `postgres-db-init` to
the existing caller list (same port, 5432); `42-allow-egress-to-rabbitmq.yaml` adds a separate rule pair
for `rabbitmq-init` on port 15672 (the management API `rabbitmqadmin` needs, not AMQP 5672) rather than
widening the app services' existing 5672-only rule. Re-ran the same test with the fixed policies: both
hooks completed. Redis needed no such fix — it has no init Job.

## Verification (real cluster, not just `helm template`)

`helm lint`/`helm template` (CI: `.github/workflows/helm.yml`) only catch structural regressions —
they never schedule a Pod, so a `runAsUser`/`readOnlyRootFilesystem` combination the image actually
rejects, or a probe command that fails at runtime, would pass CI silently. Verified once against a real
kind cluster (kind v0.30.0, default CNI — enforcement of `policies/41` needs Calico, see
`infrastructure/kubernetes/README.md`, and isn't required to check Redis itself comes up):

```bash
kind create cluster --name platform-lab
kubectl apply -f infrastructure/kubernetes/namespaces/
helm upgrade --install platform-data infrastructure/helm/platform-data -n platform-lab
kubectl rollout status deployment/redis -n platform-lab --timeout=120s
kubectl run redis-smoke --rm -i --restart=Never --image=redis:8.2-alpine -n platform-lab \
  --command -- redis-cli -h redis ping   # expect PONG, over the same Service DNS name order-service uses
kind delete cluster --name platform-lab
```

Result (2026-09-28, Redis): Pod reached `1/1 Running` via the readiness probe, `redis-cli -h redis ping`
returned `PONG` through the ClusterIP Service, effective Pod `securityContext` matched the manifest
(`runAsUser/runAsGroup: 999`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`), and no
warning events or log errors — confirms the non-root/read-only/no-persistence combination the Deployment
declares actually runs, not just renders.

Result (2026-09-28, PostgreSQL — same cluster, CNPG operator installed first per the command above):

```bash
helm upgrade --install platform-data infrastructure/helm/platform-data -n platform-lab
kubectl exec -n platform-lab postgres-1 -c postgres -- psql -U postgres -d postgres -c "\l"
```

- `helm upgrade --install` itself only returned once the `db-init` post-install hook Job had completed
  (Helm blocks on hook completion) — `psql \l` afterwards showed exactly `user_service`, `order_service`,
  `notification_worker` and `keycloak` (plus CNPG's own unused default `app`/`app` bootstrap database),
  all owned by `postgres`.
- Re-ran `helm upgrade --install` against the same PVC: succeeded again, still exactly those four
  databases, no duplicate/error — confirms #12-3's idempotency requirement. Each run's Job pod was gone
  immediately after (`hook-delete-policy: hook-succeeded`), matching intent.
- `kubectl delete pod postgres-1`: CNPG rescheduled it, it reattached to the same PVC, and all four
  databases were still there once it reported Ready — the #12 test plan's "Postgres pod is killed" case.

Result (2026-09-28, RabbitMQ — same cluster, both operators installed):

```bash
helm upgrade --install platform-data infrastructure/helm/platform-data -n platform-lab
kubectl exec -n platform-lab rabbitmq-server-0 -- rabbitmqadmin --host localhost \
  --username "$(kubectl get secret rabbitmq-default-user -n platform-lab -o jsonpath='{.data.username}' | base64 -d)" \
  --password "$(kubectl get secret rabbitmq-default-user -n platform-lab -o jsonpath='{.data.password}' | base64 -d)" \
  list queues
```

- `helm upgrade --install` returned only once `rabbitmq-init` had completed; `list queues`/`list
  exchanges` afterwards showed exactly `notification.order-created`, `.retry` and `.dlq`, and the
  `orders`/`orders.retry`/`orders.requeue` exchanges — matching `messaging/rabbitmq/README.md`'s topology
  diagram exactly.
- Re-ran `helm upgrade --install`: succeeded again, same topology, no duplicate/error objects — #12-4's
  idempotency requirement.
- `kubectl delete pod rabbitmq-server-0`: rescheduled, reattached to its PVC, same topology present once
  Ready — the #12 test plan's pod-killed case, for RabbitMQ as well as PostgreSQL.
- The NetworkPolicy-enforcement gap and fix described above was found and re-verified in this same pass
  (separate kind+Calico cluster, both operators, `policies/` applied, `helm upgrade` forced to re-run
  both Jobs).

All three dependencies (#12) are implemented and verified as of 2026-09-28. Remaining open items are the
RabbitMQ backup/restore decision's own follow-through (none needed — see the decision table above) and
keeping `infrastructure/kubernetes/policies/`'s `cnpg.io/cluster`/`app.kubernetes.io/name` assumptions
in sync if either operator's labeling ever changes.
