# Raw Kubernetes manifests

## Decision (#8-1): what lives here vs. in Helm

One source of truth per resource type — nothing here duplicates what a chart already owns:

- **Namespace** (`namespaces/`) and **the cluster's traffic entry point** (`ingress/`) are raw manifests.
  They are cluster-scoped or address another chart's Service by name, so folding them into
  `infrastructure/helm/platform-lab` would couple that chart to ingress-controller specifics.
- **ConfigMaps** and the **Deployments/Services** for the four application services are Helm-only
  (`infrastructure/helm/platform-lab`, #7) — never duplicated here. `config/`, `services/` and
  `workloads/` were removed: under this decision they will never hold a raw manifest.
- **StorageClass/PVC** definitions live next to the chart that owns the stateful workload, not here —
  PostgreSQL/RabbitMQ storage belongs to #12's chart, Keycloak's database to #11's. `storage/` was
  removed for the same reason. **#8-4 is deferred to #11/#12**; see the decision comment on
  [issue #8](https://github.com/veyselkaraca/platform-engineering-lab/issues/8).
- **Secrets are never committed** (AGENTS.md §24). `.gitignore` already enforces this for `secrets/`
  (only `.gitkeep`/`*.example.yaml` are allowed there); the runbook below is the actual documentation.
- **NetworkPolicies** (`policies/`) stay out of scope here — #9 owns that directory.

## Traffic entry point: Gateway API (not Ingress)

`ingress/` uses Gateway API (`GatewayClass`/`Gateway`/`HTTPRoute`) instead of a classic `Ingress` object.
`ingress-nginx` — the controller the issue originally assumed — was retired by the Kubernetes project in
March 2026 (repo archived, no more security patches), so a new dependency on it would be wrong from day
one. [Envoy Gateway](https://gateway.envoyproxy.io/) is the controller: Gateway-API-native, no service
mesh/sidecar overhead, actively maintained. `api-gateway-httproute.yaml` routes every path to the
`api-gateway` Service (port 3000) only — every other service stays ClusterIP-only and unreachable from
outside the cluster, matching `infrastructure/helm/platform-lab/README.md`.

### One-time per-cluster bootstrap (not part of this repo's manifests)

The controller itself is cluster infrastructure, installed once per cluster the same way an ingress
controller would be — it is not vendored here:

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.1 \
  -n envoy-gateway-system --create-namespace
kubectl wait --timeout=120s -n envoy-gateway-system deployment/envoy-gateway --for=condition=Available
```

This also installs the Gateway API CRDs (`crds.enabled=true` is the chart default) — `kubectl apply
--dry-run=server` and any real `apply` of `infrastructure/kubernetes/ingress/` need this done first.

## Apply order

```bash
kubectl apply -f infrastructure/kubernetes/namespaces/
# then, after the one-time bootstrap above and before `helm install` (see secrets runbook for Secrets):
kubectl apply -f infrastructure/kubernetes/ingress/
```

`helm install`/`upgrade` targets the namespace this creates (`-n platform-lab`, no `--create-namespace` —
the Namespace is owned here, not by Helm; see `infrastructure/helm/platform-lab/README.md`).

Secrets: `docs/operations/runbooks/kubernetes-secrets.md`.
