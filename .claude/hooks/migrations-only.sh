#!/usr/bin/env bash
# PreToolUse guard: the database schema changes only through committed migrations.
#
# Blocks two ways of skipping migrations/:
#   1. `drizzle-kit push` — writes the schema straight to the database, and proposes
#      destructive phantom drops on partial and expression indexes (this schema has both).
#   2. DDL typed at a psql prompt — CREATE / ALTER / DROP / TRUNCATE / RENAME, and
#      GRANT / REVOKE / role changes, which are schema too.
#
# Reads the tool payload on stdin. Exit 2 blocks the call and shows the message to
# Claude; exit 0 allows it. Reads and SELECTs are untouched. Anything unexpected allows
# the call — a broken guard must not wedge the session.
set -uo pipefail

payload="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

command_line="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
[[ -z "${command_line// }" ]] && exit 0

# Applying migrations is the sanctioned path, whatever else the line contains.
if printf '%s' "$command_line" | grep -Eq 'drizzle-kit[[:space:]]+(migrate|generate|up|check|studio)|db:(migrate|generate|studio)'; then
  exit 0
fi

if printf '%s' "$command_line" | grep -Eq 'drizzle-kit[[:space:]]+push|db:push'; then
  cat >&2 <<'EOF'
Blocked: `drizzle-kit push` is banned in this repo.

The database changes only through committed migrations. push writes the schema
straight to the database and is known to propose destructive phantom drops on partial
and expression indexes — this schema has both.

Do this instead:
  1. edit src/server/db/schema/
  2. pnpm db:generate
  3. read the SQL it wrote in migrations/
  4. pnpm db:migrate
  5. commit migrations/ with the schema change
EOF
  exit 2
fi

# DDL through a database client.
if printf '%s' "$command_line" | grep -Eiq '(psql|pg_dump|pgcli)' &&
   printf '%s' "$command_line" | grep -Eiq '\b(create|alter|drop|truncate|rename)[[:space:]]+(table|index|type|schema|view|materialized|sequence|role|user|policy|function|trigger|extension|database|publication)\b|\b(grant|revoke)[[:space:]]|\brow[[:space:]]+level[[:space:]]+security\b'; then
  cat >&2 <<'EOF'
Blocked: schema change typed at a database client.

DDL — CREATE / ALTER / DROP / TRUNCATE / RENAME, and GRANT / REVOKE / roles / RLS —
belongs in a migration, so the change is reviewable, repeatable on a fresh database,
and present in git. A statement run by hand exists only in this database.

Do this instead:
  - schema: edit src/server/db/schema/, then pnpm db:generate && pnpm db:migrate
  - roles, grants, RLS policies: add a hand-written .sql file in migrations/ and
    register it in migrations/meta/_journal.json, then pnpm db:migrate

Reading the database (SELECT, \dt, \d+) is fine and not blocked.
EOF
  exit 2
fi

exit 0
