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
| PostgreSQL | CloudNativePG operator | Proposed, not yet implemented | Encodes PVC, failover and minor-version upgrade handling a bespoke StatefulSet would reinvent (AGENTS.md §7.12). Operational cost: one more CRD/controller. Known conflict to resolve when implemented: CNPG's default Pod/Service labels are `cnpg.io/cluster: <name>`, not `app.kubernetes.io/name: postgres` — the existing NetworkPolicy assumption in `infrastructure/kubernetes/policies/40-allow-egress-to-postgres.yaml` needs either a label override on the `Cluster` resource or a policy update. |
| RabbitMQ | RabbitMQ Cluster Operator | Proposed, not yet implemented | Same reasoning as PostgreSQL. Installs from a GitHub release manifest, not a Helm repo (issue #12 comment). Naming the `RabbitmqCluster` resource `rabbitmq` should make the operator's default labels satisfy `infrastructure/kubernetes/policies/42-allow-egress-to-rabbitmq.yaml`'s `app.kubernetes.io/name: rabbitmq` assumption directly — to confirm when implemented. |

## Decision (#12-6): backup/restore

Not recorded yet — depends on the PostgreSQL and RabbitMQ phases above landing first. Tracked as part
of #12, not a silent gap.

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

Result (2026-09-28): Pod reached `1/1 Running` via the readiness probe, `redis-cli -h redis ping`
returned `PONG` through the ClusterIP Service, effective Pod `securityContext` matched the manifest
(`runAsUser/runAsGroup: 999`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`), and no
warning events or log errors — confirms the non-root/read-only/no-persistence combination the Deployment
declares actually runs, not just renders. Repeat this same sequence for PostgreSQL/RabbitMQ once their
phases land, extending the `helm upgrade --install` and smoke-check steps rather than replacing them.

## Out of scope here (this phase)

PostgreSQL, RabbitMQ, their `db-init`/`rabbitmq-init` Job equivalents (#12-3/#12-4), and the #12-6
backup/restore decision — tracked in #12, implemented in a later phase.
