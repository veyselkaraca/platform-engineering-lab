# platform-lab Helm chart

One Deployment + ClusterIP Service + ConfigMap per service (api-gateway, user-service, order-service,
notification-worker) as four explicit template pairs sharing `templates/_helpers.tpl` for labels and the
secret-env helper — not a `range`-over-services loop, so each service's actual env surface stays visible
in its own template instead of hidden behind generic iteration.

```bash
helm lint infrastructure/helm/platform-lab
helm template platform-lab infrastructure/helm/platform-lab \
  --set apiGateway.image.tag=<commit-sha> --set userService.image.tag=<commit-sha> \
  --set orderService.image.tag=<commit-sha> --set notificationWorker.image.tag=<commit-sha>

helm upgrade --install platform-lab infrastructure/helm/platform-lab \
  -n platform-lab \
  -f infrastructure/helm/platform-lab/values-<env>.yaml \
  --set apiGateway.image.tag=<commit-sha> --set userService.image.tag=<commit-sha> \
  --set orderService.image.tag=<commit-sha> --set notificationWorker.image.tag=<commit-sha>
```

The `platform-lab` Namespace is a raw manifest (`infrastructure/kubernetes/namespaces/`, #8), applied
before this chart — never pass `--create-namespace` here, or Helm takes ownership of a Namespace it
doesn't own and a later `kubectl apply` of the same manifest conflicts on the ownership metadata.

Image tags are never set in `values.yaml` itself (default `local`, mirroring compose's own
`${GIT_SHA:-local}`); every real deploy passes the immutable `<service>:<commit-sha>` tag explicitly, so
CI or a human always states which commit is going out (AGENTS.md §7.3).

Non-secret env vars (`LOG_LEVEL`, `AUTH_*`, `OTEL_*`, URLs of other in-cluster services, …) come from each
service's ConfigMap, built from `.Values.<service>.env`. `DATABASE_URL` and `RABBITMQ_URL` (both carry
credentials) come from a pre-existing Secret named in `.Values.<service>.secretEnv` — this chart never
creates, generates or reads the Secret's value; provisioning it is out of scope here (#8/#24).

Only api-gateway's Service is meant for external exposure, via the Gateway API `HTTPRoute` in
`infrastructure/kubernetes/ingress/` (#8 — a classic `Ingress` was superseded by Gateway API after
ingress-nginx's March 2026 retirement); all four are ClusterIP today, matching compose's "only the
gateway is exposed in a cluster".

`values-prod.yaml` is one example of a per-environment override file: it changes replica counts and
environment-specific config (issuer URL, OTEL sampling, secret names), never image tags — those come from
`--set` at deploy time since only CI knows the commit being deployed.

Rollback: `helm rollback platform-lab <revision>` restores the previous chart+values without rebuilding
(exact, because tags are immutable). A rollout that never turns Ready halts itself via
`rollingUpdate.maxUnavailable: 0`.

Out of scope here: TLS (not required by #8 either — plain HTTP Gateway/HTTPRoute, AGENTS.md §7.12),
NetworkPolicies (#9), the observability/Keycloak/data charts (#10-#12), the Secrets themselves
(`docs/operations/runbooks/kubernetes-secrets.md`) and automated deploy (#14/#15).
