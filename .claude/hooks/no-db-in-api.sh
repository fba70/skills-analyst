#!/usr/bin/env bash
# PreToolUse guard: no database access from API route handlers.
#
# Queries belong in src/server/**, called from server components and server actions,
# where the DAL resolves session and org. Route handlers under src/app/api/** get no
# database. The one exception is src/app/api/auth/**, which Better Auth owns.
#
# Reads the tool payload on stdin. Exit 2 blocks the call and shows the message to
# Claude; exit 0 allows it. Anything unexpected allows the call — a broken guard must
# not wedge the session. The ESLint rule in eslint.config.mjs is the backstop.
set -uo pipefail

payload="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"
[[ -z "$path" ]] && exit 0

# Only API routes, and never the Better Auth catch-all.
[[ "$path" != *"/src/app/api/"* && "$path" != "src/app/api/"* ]] && exit 0
[[ "$path" == *"/src/app/api/auth/"* || "$path" == "src/app/api/auth/"* ]] && exit 0

# Everything this call would write: whole-file content, or the replacement side of edits.
written="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.content // empty,
    .tool_input.new_string // empty,
    ( .tool_input.edits // [] | map(.new_string // empty) | join("\n") )
  ] | join("\n")
')"
[[ -z "${written// }" ]] && exit 0

if printf '%s' "$written" | grep -Eq '@/server/db|from[[:space:]]+["'"'"']pg["'"'"']|drizzle-orm|node-postgres'; then
  cat >&2 <<EOF
Blocked: no database access from API routes.

  file: $path

All database interaction goes through src/server/** and is called from a Next.js
server component or server action, so the DAL resolves the session and the org.
Route handlers do not query the database.

Fix: put the query in src/server/dal/, then read it from a server component.
Only src/app/api/auth/** is exempt (Better Auth owns its own endpoints).
See the "Database access" section in CLAUDE.md.
EOF
  exit 2
fi

exit 0
