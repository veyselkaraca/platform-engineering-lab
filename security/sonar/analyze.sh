#!/bin/sh
# Analyze one service with the SonarQube server of the `quality` compose profile and fail when the quality gate fails.
# Usage (repo root, after `npm test -- --coverage --coverageReporters=lcov` in the service):
#   sh security/sonar/analyze.sh <service>
# Idempotent: the admin password is set once, the scan token is replaced on every run, the project is created on first scan.
set -eu
cd "$(dirname "$0")/../.."

service=${1:?usage: analyze.sh <service>}
[ -f "services/$service/coverage/lcov.info" ] || { echo "no coverage report: run 'npm test -- --coverage --coverageReporters=lcov' in services/$service first" >&2; exit 1; }

env=infrastructure/docker/.env
value() { sed -n "s/^$1=//p" "$env" | tail -n 1; }
password=$(value SONAR_ADMIN_PASSWORD)
host=${SONAR_HOST_URL:-http://localhost:$(value SONARQUBE_HOST_PORT)}
[ -n "$password" ] || { echo "SONAR_ADMIN_PASSWORD missing in $env (run scripts/bootstrap.sh)" >&2; exit 1; }

curl -sf --max-time 10 "$host/api/system/status" | grep -q '"status":"UP"' ||
  { echo "SonarQube is not up at $host (docker compose --profile quality up -d --wait sonarqube)" >&2; exit 1; }

# A fresh server has admin/admin; replace it. Fails harmlessly once the password has been changed.
curl -s --max-time 10 -o /dev/null -u admin:admin -X POST "$host/api/users/change_password" \
  -d login=admin -d previousPassword=admin --data-urlencode "password=$password" || true
curl -sf --max-time 10 -u "admin:$password" "$host/api/authentication/validate" | grep -q '"valid":true' ||
  { echo "cannot authenticate as admin with SONAR_ADMIN_PASSWORD" >&2; exit 1; }

# The gate is SonarQube's built-in "Sonar way" (ADR-002); refuse to scan if the default gate was swapped.
curl -sf --max-time 10 -u "admin:$password" "$host/api/qualitygates/list" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const g = d.qualitygates.find((q) => q.isDefault);
  if (!g || g.name !== "Sonar way" || !g.isBuiltIn) { console.error("default quality gate is not the built-in Sonar way: " + (g && g.name)); process.exit(1); }'

curl -s --max-time 10 -o /dev/null -u "admin:$password" -X POST "$host/api/user_tokens/revoke" -d name=analyze || true
token=$(curl -sf --max-time 10 -u "admin:$password" -X POST "$host/api/user_tokens/generate" -d name=analyze |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).token)')
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$token"

cd "services/$service"
# @sonar/scan needs no Java: it downloads the scanner engine and a JRE from the server.
SONAR_TOKEN=$token SONAR_HOST_URL=$host npx --yes @sonar/scan@4.4.0 \
  -Dproject.settings=../../security/sonar/sonar-project.properties \
  -Dsonar.projectKey="platform-lab-$service" \
  -Dsonar.projectName="platform-lab-$service" \
  -Dsonar.qualitygate.wait=true \
  -Dsonar.qualitygate.timeout=300
