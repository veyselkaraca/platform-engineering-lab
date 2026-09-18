#!/bin/sh
# Idempotent local setup: create git-ignored .env files from the samples if missing.
set -eu
cd "$(dirname "$0")/.."
[ -f infrastructure/docker/.env ] || cp infrastructure/docker/.env.example infrastructure/docker/.env
echo "ready: infrastructure/docker/.env"
