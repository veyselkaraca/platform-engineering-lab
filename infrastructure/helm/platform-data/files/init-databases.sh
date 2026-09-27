#!/bin/sh
# Creates one database per name in POSTGRES_MULTIPLE_DATABASES (comma-separated).
# Idempotent: safe on every `up`, including against an existing data volume.
# Connection comes from the standard libpq variables (PGHOST, PGUSER, PGPASSWORD).
set -eu
for db in $(echo "${POSTGRES_MULTIPLE_DATABASES:-}" | tr ',' ' '); do
  psql -v ON_ERROR_STOP=1 -d postgres <<SQL
SELECT 'CREATE DATABASE "$db"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
SQL
done
