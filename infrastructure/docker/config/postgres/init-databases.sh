#!/bin/sh
# Creates one database per name in POSTGRES_MULTIPLE_DATABASES (comma-separated).
# Runs only on first init of an empty data volume. Idempotent per database.
set -eu
for db in $(echo "${POSTGRES_MULTIPLE_DATABASES:-}" | tr ',' ' '); do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<SQL
SELECT 'CREATE DATABASE "$db"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
SQL
done
