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
- **NetworkPolicies** (`policies/`) are raw manifests too, for the same reason as the Namespace: a
  default-deny + per-service allow set is namespace-scoped policy, not a workload the chart owns.

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

`policies/` (#9) needs a CNI that actually enforces `NetworkPolicy` — kindnet, kind's default CNI, silently
accepts the objects but never blocks traffic, so its test plan's "a blocked path is actually blocked"
check would pass for the wrong reason. Recreate the local cluster with the default CNI disabled and
install a policy-enforcing one (e.g. Calico) before relying on that check:

```bash
kind create cluster --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
EOF
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.29.1/manifests/calico.yaml
kubectl wait --timeout=180s -n kube-system -l k8s-app=calico-node --for=condition=Ready pod
```

Verified 2026-09-27 on kind v0.30.0 + Calico v3.29.1, twice: first with stand-in pods, then with the
actual `platform-lab` Helm chart (#7, local images) plus throwaway Postgres/Redis/RabbitMQ deployments
carrying the labels `40`/`41`/`42` in `policies/` assume, and Envoy Gateway (`infrastructure/kubernetes/README.md`'s
bootstrap) actually installed:

- An allowed path (api-gateway → user-service; order-service → Redis/RabbitMQ) succeeded; an unlabeled
  scratch pod timed out reaching a backend directly; a service reaching a dependency it doesn't use
  (user-service → RabbitMQ/Redis) also timed out.
- A real request through Envoy Gateway → `HTTPRoute` → api-gateway returned `401` (no token) — a real
  application response, not a network timeout, proving the ingress path itself is open.
- Caught a real gap this way: an Ingress-only allow on a callee (e.g. `30-allow-gateway-to-backends.yaml`)
  is not enough — `00-default-deny.yaml` blocks Egress on the *caller* independently, so every pair needs
  a matching rule on both sides (`21-allow-api-gateway-egress-to-backends.yaml`, and the Ingress half
  added to `40`/`41`/`42`/`50`/`60` alongside their Egress half, mirror this).
- A pod that already held an open connection before a policy gap was fixed (e.g. TypeORM's pool to
  Postgres) kept working across `kubectl apply` — conntrack allows established flows through even
  without a matching rule for new ones. Don't trust "still Ready" as proof a policy is correct; restart
  the pod (`kubectl delete pod`) to force a fresh connection under the current rules.

Confirms Calico is enforcing, not just accepting, these objects — kindnet accepts the same manifests
without blocking anything.

## Apply order

```bash
kubectl apply -f infrastructure/kubernetes/namespaces/
# then, after the one-time bootstrap above and before `helm install` (see secrets runbook for Secrets):
kubectl apply -f infrastructure/kubernetes/ingress/
# then, after `helm install`/`upgrade` of both infrastructure/helm/platform-lab and
# infrastructure/helm/platform-data (#9 — policies select on the workloads' own pod labels, so the
# Pods must already exist) and before real traffic reaches the namespace:
kubectl apply -f infrastructure/kubernetes/policies/
```

`helm install`/`upgrade` targets the namespace this creates (`-n platform-lab`, no `--create-namespace` —
the Namespace is owned here, not by Helm; see `infrastructure/helm/platform-lab/README.md`).

Secrets: `docs/operations/runbooks/kubernetes-secrets.md`.

## Diagnosing a NetworkPolicy block (#9)

A missing allow rule looks different from a backend-down 502: the gateway (or `kubectl exec ... --
curl`) hangs until its own timeout instead of failing fast, because the connection is dropped silently
at the network layer rather than refused by an application. Symptoms:

- A specific caller→callee path times out while everything else works → check
  `infrastructure/kubernetes/policies/` for a rule covering that pair (or run
  `kubectl exec -n platform-lab <pod> -- curl -m 3 http://<target>:<port>` to confirm the block).
- Everything times out right after applying `policies/` → `00-default-deny.yaml` landed before its
  matching allow rule, or before the target Pods existed yet for a label selector to match. Recovery:
  re-apply the whole `policies/` directory together (allow rules are additive, order within the
  directory doesn't matter once all files are applied), or delete `default-deny` temporarily.
- The egress rules to Postgres/RabbitMQ/Keycloak/the OTEL collector (`40`, `42`, `50`-`60` in
  `policies/`) encode an *assumed* `app.kubernetes.io/name` label for workloads #10/#11/#12 haven't
  shipped yet — once one of those charts lands, confirm its actual pod labels match, or update the
  policy. Redis's rule (`41`) is confirmed: `infrastructure/helm/platform-data`'s plain Deployment
  carries `app.kubernetes.io/name: redis` on port 6379 exactly as assumed.
