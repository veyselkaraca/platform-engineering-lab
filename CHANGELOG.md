# Changelog

## [0.1.0](https://github.com/veyselkaraca/platform-engineering-lab/compare/v0.1.1...v0.1.0) (2026-09-23)


* bootstrap the first release at v0.1.0 ([29867ea](https://github.com/veyselkaraca/platform-engineering-lab/commit/29867eaa7d76970cb313436daca6d8aec79a6e5e))


### Features

* **api-gateway:** add gateway with routing, request-id correlation and rate limiting ([a404c41](https://github.com/veyselkaraca/platform-engineering-lab/commit/a404c413b1b2c2d85c641a5b9b080096c37e4e3a))
* **api-gateway:** reject requests without a valid Keycloak token; add auth to CI smoke and a Keycloak outage check ([14a3ae8](https://github.com/veyselkaraca/platform-engineering-lab/commit/14a3ae8dc23f5459b5d0933c78291d635ea33af4))
* **infra:** add api-gateway to the stack and run the smoke flow through it ([d0c87d4](https://github.com/veyselkaraca/platform-engineering-lab/commit/d0c87d4bc6fbae11d5a7c1d9e8be7483adae10d4))
* **infra:** add Keycloak with a dev realm to the stack and make the smoke test use real tokens ([9f19a36](https://github.com/veyselkaraca/platform-engineering-lab/commit/9f19a364061999c56a1dc64cec5951c713e5d432))
* **infra:** add local Docker Compose runtime, smoke test and VS Code debug config ([e169077](https://github.com/veyselkaraca/platform-engineering-lab/commit/e1690770c30a4624bbf31ec45348d37996355824))
* **infra:** add notification-worker to the stack, DLQ replay and end-to-end smoke check ([5236191](https://github.com/veyselkaraca/platform-engineering-lab/commit/52361911c3669aa2d205edf78112519681eae1f5))
* **infra:** add Redis, RabbitMQ and order-service to the local stack, generalize CI ([44d390f](https://github.com/veyselkaraca/platform-engineering-lab/commit/44d390fe75162138798e30739b2e350045eab644))
* **notification-worker:** add idempotent order.created consumer with retry and dead-lettering ([6812952](https://github.com/veyselkaraca/platform-engineering-lab/commit/68129526fc51109d4512df9addf7cebd1e0b75e8))
* **notification-worker:** verify Keycloak JWTs and show customers only their own notifications ([179bef5](https://github.com/veyselkaraca/platform-engineering-lab/commit/179bef5b21aab0812360fc5a635c2ca73e1baa9f))
* **observability:** add dashboards, alert rules with SLO burn rates, runbook and pipeline tests ([d1f4f73](https://github.com/veyselkaraca/platform-engineering-lab/commit/d1f4f732c97f17cc6b6fdc018b085bd6c5f6813f))
* **observability:** chaos scenarios for the telemetry pipeline and alerts, docs, CI wiring ([5e8419c](https://github.com/veyselkaraca/platform-engineering-lab/commit/5e8419c3cd624dc33aba9cb3d8c2e4d44b5aec47))
* **observability:** instrument the services with OpenTelemetry and add the opt-in telemetry stack ([c80b25a](https://github.com/veyselkaraca/platform-engineering-lab/commit/c80b25ad5c449750d081420bf59cbb5c698a58cd))
* **order-service:** add order service with idempotent creation and order.created events ([dee03f5](https://github.com/veyselkaraca/platform-engineering-lab/commit/dee03f525ac9579a1d346014fdae83d8f983c341))
* **order-service:** verify Keycloak JWTs, enforce role and ownership, scope idempotency keys per user ([aebb0e5](https://github.com/veyselkaraca/platform-engineering-lab/commit/aebb0e58016170af83373443b2d3ae67ab63a61e))
* **security:** add dependency advisory gate with time-boxed exceptions ([#3](https://github.com/veyselkaraca/platform-engineering-lab/issues/3)) ([e6c59fb](https://github.com/veyselkaraca/platform-engineering-lab/commit/e6c59fbb4416110633daf749979af54638509cc4))
* **user-service:** add NestJS user service with health checks and PostgreSQL ([cba26c2](https://github.com/veyselkaraca/platform-engineering-lab/commit/cba26c299789ad79bbd230c16b12939efdecb9ff))
* **user-service:** verify Keycloak JWTs and authorize by role and ownership ([751e61c](https://github.com/veyselkaraca/platform-engineering-lab/commit/751e61c441e2c34341c63a67d9a5f0af6680f70f))


### Bug Fixes

* answer 503, not 500, when the database is unreachable, and bound the connect time ([edb1cd9](https://github.com/veyselkaraca/platform-engineering-lab/commit/edb1cd9a12b33d6be3b003dd57720bb86408aeeb))
* **ci:** bump trivy-action to v0.36.0 (v0.28.0 depends on a deleted setup-trivy tag) ([669e606](https://github.com/veyselkaraca/platform-engineering-lab/commit/669e60671dc87b7eb37b0899c956c3e4064a84fd))
* **ci:** grant actions: read so the CodeQL analyze step can finish ([452ebc9](https://github.com/veyselkaraca/platform-engineering-lab/commit/452ebc9eda7f02c685981966e017a2f9a3f42a06))
* **ci:** use the v-prefixed trivy-action tag ([cb60a85](https://github.com/veyselkaraca/platform-engineering-lab/commit/cb60a851a11b7f560900f909ec64c8bd122bf4c7))
* **observability:** drop http.status_code from httpcheck_status so a recovered service is not reported not ready ([9e0d486](https://github.com/veyselkaraca/platform-engineering-lab/commit/9e0d4860988764c3f92674085d62b8f39ff74a57))
* **observability:** make the service variable's All a non-empty matcher so Loki accepts the log panel ([2f31b3f](https://github.com/veyselkaraca/platform-engineering-lab/commit/2f31b3f47da5b0cdd739a720a3c620720ecb9c6b))
* **release:** don't publish a release before every service is retagged ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([2d2ca59](https://github.com/veyselkaraca/platform-engineering-lab/commit/2d2ca592ed5d181b1307617e5f43162f9961d85f))
* **release:** fail fast when a service pipeline fails instead of timing out ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([2f460bb](https://github.com/veyselkaraca/platform-engineering-lab/commit/2f460bbacbff77b5fe88e38cd13820b15e5f7090))
* **release:** widen the retag wait to 30 minutes ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([cfa87f2](https://github.com/veyselkaraca/platform-engineering-lab/commit/cfa87f2dc831cf6d9ced64f13c69c9a8226f9e49))
* **tests:** escape the dot in the publish_failed log pattern (CodeQL js/useless-regexp-character-escape) ([6941366](https://github.com/veyselkaraca/platform-engineering-lab/commit/694136686df630ab34ca4e3deb74d62e8c3cb1b0))
* **tests:** use a fresh user in the telemetry pipeline test so the Redis user cache cannot hide user-service from the trace ([9d0adcb](https://github.com/veyselkaraca/platform-engineering-lab/commit/9d0adcbdcae10875c567e5ef68a6f11a231fea6c))
* **tests:** wait for stale not-ready probe samples to age out before asserting readiness ([4373a05](https://github.com/veyselkaraca/platform-engineering-lab/commit/4373a05c582a97082da1a24745ed8705ff8ccda5))


### CI/CD

* add GitHub Actions pipeline for user-service ([5dc6acc](https://github.com/veyselkaraca/platform-engineering-lab/commit/5dc6acc019ceed396314c57fc6fded3c53e4e4b6))
* add release-please versioning and same-digest release retag ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([d2091ef](https://github.com/veyselkaraca/platform-engineering-lab/commit/d2091eff55e4fea7ddfbf56b27098e83e7d48ab2))
* gate commits on the Conventional Commits format ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([96306d6](https://github.com/veyselkaraca/platform-engineering-lab/commit/96306d602807839959a9064aaa1fe6ad9d0e498c))
* gate the service pipelines on a SonarQube quality gate, keep CodeQL as a non-blocking layer ([#2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2)) ([c24540d](https://github.com/veyselkaraca/platform-engineering-lab/commit/c24540dec435bf040a37cc6a47c809553f4f6a71))
* label images with their source repository ([#6](https://github.com/veyselkaraca/platform-engineering-lab/issues/6)) ([db36d91](https://github.com/veyselkaraca/platform-engineering-lab/commit/db36d91d3b0cd54b37b43b44126b21fa01093b79))
* make CodeQL fail the pipeline on high/critical findings ([#2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2)) ([dac1ae6](https://github.com/veyselkaraca/platform-engineering-lab/commit/dac1ae6383550f13a5f8fc4cefe15838e1be93f5))
* move workflows off Node 20 actions, CodeQL v3 and ubuntu-latest ([#38](https://github.com/veyselkaraca/platform-engineering-lab/issues/38)) ([f4ee47f](https://github.com/veyselkaraca/platform-engineering-lab/commit/f4ee47fde73aa4d9b32aaa42a4a1740bbd97025f)), closes [#27](https://github.com/veyselkaraca/platform-engineering-lab/issues/27)
* print collector, Loki and Tempo state when the platform tests fail ([9191bce](https://github.com/veyselkaraca/platform-engineering-lab/commit/9191bce7061dc2cc9c5322a1094d77fdce598d3e))
* read image-scan exceptions from security/image-scan and trigger pipelines on changes ([#4](https://github.com/veyselkaraca/platform-engineering-lab/issues/4)) ([5ee1fe9](https://github.com/veyselkaraca/platform-engineering-lab/commit/5ee1fe9912e0966af3161a13428fcd062d96934c))
* record the published digest and never overwrite a SHA tag ([#6](https://github.com/veyselkaraca/platform-engineering-lab/issues/6)) ([8d84c91](https://github.com/veyselkaraca/platform-engineering-lab/commit/8d84c9164dc3b00fdc11b0c4e1c6c1f06d91467d))
* run the dependency gate in the verify job of every service pipeline ([#3](https://github.com/veyselkaraca/platform-engineering-lab/issues/3)) ([8249a7f](https://github.com/veyselkaraca/platform-engineering-lab/commit/8249a7fabe2a2651722d60d92bee6b24bd451f57))
* run the pipelines on every branch, publish only from main ([#30](https://github.com/veyselkaraca/platform-engineering-lab/issues/30)) ([6b9c519](https://github.com/veyselkaraca/platform-engineering-lab/commit/6b9c519e7a3b0bd7449013df6207549cac2bdcd1))
* scan the git history with gitleaks on every push and PR and before publishing ([#5](https://github.com/veyselkaraca/platform-engineering-lab/issues/5)) ([20d2112](https://github.com/veyselkaraca/platform-engineering-lab/commit/20d21126bc72aa9704b6230f77f8a2c71cd3f995))

## [0.1.1](https://github.com/veyselkaraca/platform-engineering-lab/compare/v0.1.0...v0.1.1) (2026-09-23)


### Bug Fixes

* **release:** don't publish a release before every service is retagged ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([2d2ca59](https://github.com/veyselkaraca/platform-engineering-lab/commit/2d2ca592ed5d181b1307617e5f43162f9961d85f))
* **release:** fail fast when a service pipeline fails instead of timing out ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([2f460bb](https://github.com/veyselkaraca/platform-engineering-lab/commit/2f460bbacbff77b5fe88e38cd13820b15e5f7090))
* **release:** widen the retag wait to 30 minutes ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([cfa87f2](https://github.com/veyselkaraca/platform-engineering-lab/commit/cfa87f2dc831cf6d9ced64f13c69c9a8226f9e49))


### CI/CD

* move workflows off Node 20 actions, CodeQL v3 and ubuntu-latest ([#38](https://github.com/veyselkaraca/platform-engineering-lab/issues/38)) ([f4ee47f](https://github.com/veyselkaraca/platform-engineering-lab/commit/f4ee47fde73aa4d9b32aaa42a4a1740bbd97025f)), closes [#27](https://github.com/veyselkaraca/platform-engineering-lab/issues/27)

## 0.1.0 (2026-09-23)


* bootstrap the first release at v0.1.0 ([29867ea](https://github.com/veyselkaraca/platform-engineering-lab/commit/29867eaa7d76970cb313436daca6d8aec79a6e5e))


### Features

* **api-gateway:** add gateway with routing, request-id correlation and rate limiting ([a404c41](https://github.com/veyselkaraca/platform-engineering-lab/commit/a404c413b1b2c2d85c641a5b9b080096c37e4e3a))
* **api-gateway:** reject requests without a valid Keycloak token; add auth to CI smoke and a Keycloak outage check ([14a3ae8](https://github.com/veyselkaraca/platform-engineering-lab/commit/14a3ae8dc23f5459b5d0933c78291d635ea33af4))
* **infra:** add api-gateway to the stack and run the smoke flow through it ([d0c87d4](https://github.com/veyselkaraca/platform-engineering-lab/commit/d0c87d4bc6fbae11d5a7c1d9e8be7483adae10d4))
* **infra:** add Keycloak with a dev realm to the stack and make the smoke test use real tokens ([9f19a36](https://github.com/veyselkaraca/platform-engineering-lab/commit/9f19a364061999c56a1dc64cec5951c713e5d432))
* **infra:** add local Docker Compose runtime, smoke test and VS Code debug config ([e169077](https://github.com/veyselkaraca/platform-engineering-lab/commit/e1690770c30a4624bbf31ec45348d37996355824))
* **infra:** add notification-worker to the stack, DLQ replay and end-to-end smoke check ([5236191](https://github.com/veyselkaraca/platform-engineering-lab/commit/52361911c3669aa2d205edf78112519681eae1f5))
* **infra:** add Redis, RabbitMQ and order-service to the local stack, generalize CI ([44d390f](https://github.com/veyselkaraca/platform-engineering-lab/commit/44d390fe75162138798e30739b2e350045eab644))
* **notification-worker:** add idempotent order.created consumer with retry and dead-lettering ([6812952](https://github.com/veyselkaraca/platform-engineering-lab/commit/68129526fc51109d4512df9addf7cebd1e0b75e8))
* **notification-worker:** verify Keycloak JWTs and show customers only their own notifications ([179bef5](https://github.com/veyselkaraca/platform-engineering-lab/commit/179bef5b21aab0812360fc5a635c2ca73e1baa9f))
* **observability:** add dashboards, alert rules with SLO burn rates, runbook and pipeline tests ([d1f4f73](https://github.com/veyselkaraca/platform-engineering-lab/commit/d1f4f732c97f17cc6b6fdc018b085bd6c5f6813f))
* **observability:** chaos scenarios for the telemetry pipeline and alerts, docs, CI wiring ([5e8419c](https://github.com/veyselkaraca/platform-engineering-lab/commit/5e8419c3cd624dc33aba9cb3d8c2e4d44b5aec47))
* **observability:** instrument the services with OpenTelemetry and add the opt-in telemetry stack ([c80b25a](https://github.com/veyselkaraca/platform-engineering-lab/commit/c80b25ad5c449750d081420bf59cbb5c698a58cd))
* **order-service:** add order service with idempotent creation and order.created events ([dee03f5](https://github.com/veyselkaraca/platform-engineering-lab/commit/dee03f525ac9579a1d346014fdae83d8f983c341))
* **order-service:** verify Keycloak JWTs, enforce role and ownership, scope idempotency keys per user ([aebb0e5](https://github.com/veyselkaraca/platform-engineering-lab/commit/aebb0e58016170af83373443b2d3ae67ab63a61e))
* **security:** add dependency advisory gate with time-boxed exceptions ([#3](https://github.com/veyselkaraca/platform-engineering-lab/issues/3)) ([e6c59fb](https://github.com/veyselkaraca/platform-engineering-lab/commit/e6c59fbb4416110633daf749979af54638509cc4))
* **user-service:** add NestJS user service with health checks and PostgreSQL ([cba26c2](https://github.com/veyselkaraca/platform-engineering-lab/commit/cba26c299789ad79bbd230c16b12939efdecb9ff))
* **user-service:** verify Keycloak JWTs and authorize by role and ownership ([751e61c](https://github.com/veyselkaraca/platform-engineering-lab/commit/751e61c441e2c34341c63a67d9a5f0af6680f70f))


### Bug Fixes

* answer 503, not 500, when the database is unreachable, and bound the connect time ([edb1cd9](https://github.com/veyselkaraca/platform-engineering-lab/commit/edb1cd9a12b33d6be3b003dd57720bb86408aeeb))
* **ci:** bump trivy-action to v0.36.0 (v0.28.0 depends on a deleted setup-trivy tag) ([669e606](https://github.com/veyselkaraca/platform-engineering-lab/commit/669e60671dc87b7eb37b0899c956c3e4064a84fd))
* **ci:** grant actions: read so the CodeQL analyze step can finish ([452ebc9](https://github.com/veyselkaraca/platform-engineering-lab/commit/452ebc9eda7f02c685981966e017a2f9a3f42a06))
* **ci:** use the v-prefixed trivy-action tag ([cb60a85](https://github.com/veyselkaraca/platform-engineering-lab/commit/cb60a851a11b7f560900f909ec64c8bd122bf4c7))
* **observability:** drop http.status_code from httpcheck_status so a recovered service is not reported not ready ([9e0d486](https://github.com/veyselkaraca/platform-engineering-lab/commit/9e0d4860988764c3f92674085d62b8f39ff74a57))
* **observability:** make the service variable's All a non-empty matcher so Loki accepts the log panel ([2f31b3f](https://github.com/veyselkaraca/platform-engineering-lab/commit/2f31b3f47da5b0cdd739a720a3c620720ecb9c6b))
* **tests:** escape the dot in the publish_failed log pattern (CodeQL js/useless-regexp-character-escape) ([6941366](https://github.com/veyselkaraca/platform-engineering-lab/commit/694136686df630ab34ca4e3deb74d62e8c3cb1b0))
* **tests:** use a fresh user in the telemetry pipeline test so the Redis user cache cannot hide user-service from the trace ([9d0adcb](https://github.com/veyselkaraca/platform-engineering-lab/commit/9d0adcbdcae10875c567e5ef68a6f11a231fea6c))
* **tests:** wait for stale not-ready probe samples to age out before asserting readiness ([4373a05](https://github.com/veyselkaraca/platform-engineering-lab/commit/4373a05c582a97082da1a24745ed8705ff8ccda5))


### CI/CD

* add GitHub Actions pipeline for user-service ([5dc6acc](https://github.com/veyselkaraca/platform-engineering-lab/commit/5dc6acc019ceed396314c57fc6fded3c53e4e4b6))
* add release-please versioning and same-digest release retag ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([d2091ef](https://github.com/veyselkaraca/platform-engineering-lab/commit/d2091eff55e4fea7ddfbf56b27098e83e7d48ab2))
* gate commits on the Conventional Commits format ([#35](https://github.com/veyselkaraca/platform-engineering-lab/issues/35)) ([96306d6](https://github.com/veyselkaraca/platform-engineering-lab/commit/96306d602807839959a9064aaa1fe6ad9d0e498c))
* gate the service pipelines on a SonarQube quality gate, keep CodeQL as a non-blocking layer ([#2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2)) ([c24540d](https://github.com/veyselkaraca/platform-engineering-lab/commit/c24540dec435bf040a37cc6a47c809553f4f6a71))
* label images with their source repository ([#6](https://github.com/veyselkaraca/platform-engineering-lab/issues/6)) ([db36d91](https://github.com/veyselkaraca/platform-engineering-lab/commit/db36d91d3b0cd54b37b43b44126b21fa01093b79))
* make CodeQL fail the pipeline on high/critical findings ([#2](https://github.com/veyselkaraca/platform-engineering-lab/issues/2)) ([dac1ae6](https://github.com/veyselkaraca/platform-engineering-lab/commit/dac1ae6383550f13a5f8fc4cefe15838e1be93f5))
* print collector, Loki and Tempo state when the platform tests fail ([9191bce](https://github.com/veyselkaraca/platform-engineering-lab/commit/9191bce7061dc2cc9c5322a1094d77fdce598d3e))
* read image-scan exceptions from security/image-scan and trigger pipelines on changes ([#4](https://github.com/veyselkaraca/platform-engineering-lab/issues/4)) ([5ee1fe9](https://github.com/veyselkaraca/platform-engineering-lab/commit/5ee1fe9912e0966af3161a13428fcd062d96934c))
* record the published digest and never overwrite a SHA tag ([#6](https://github.com/veyselkaraca/platform-engineering-lab/issues/6)) ([8d84c91](https://github.com/veyselkaraca/platform-engineering-lab/commit/8d84c9164dc3b00fdc11b0c4e1c6c1f06d91467d))
* run the dependency gate in the verify job of every service pipeline ([#3](https://github.com/veyselkaraca/platform-engineering-lab/issues/3)) ([8249a7f](https://github.com/veyselkaraca/platform-engineering-lab/commit/8249a7fabe2a2651722d60d92bee6b24bd451f57))
* run the pipelines on every branch, publish only from main ([#30](https://github.com/veyselkaraca/platform-engineering-lab/issues/30)) ([6b9c519](https://github.com/veyselkaraca/platform-engineering-lab/commit/6b9c519e7a3b0bd7449013df6207549cac2bdcd1))
* scan the git history with gitleaks on every push and PR and before publishing ([#5](https://github.com/veyselkaraca/platform-engineering-lab/issues/5)) ([20d2112](https://github.com/veyselkaraca/platform-engineering-lab/commit/20d21126bc72aa9704b6230f77f8a2c71cd3f995))

## Changelog

All notable changes to this project are documented in this file, generated from [Conventional Commits](https://www.conventionalcommits.org) by [release-please](https://github.com/googleapis/release-please-action) (`.github/workflows/release.yml`). See [docs/operations/runbooks/release.md](docs/operations/runbooks/release.md) for how a release is cut.
