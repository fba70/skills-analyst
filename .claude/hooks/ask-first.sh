#!/usr/bin/env bash
# PreToolUse guard: four classes of action the agent may only *propose*, never run.
#
#   1. git commit / git push and anything else that writes to the remote
#   2. installing new tools or packages, or running a tool fetched on the fly
#   3. applying database migrations
#   4. deleting files, or git operations that discard work
#
# Each is a decision Boris makes. The hook blocks the call (exit 2) with a message that
# tells the agent to stop and prompt the user with the exact command. Exit 0 allows the
# call. Anything unexpected allows the call — a broken guard must not wedge the session.
#
# There is deliberately **no override**. One was built and removed the same afternoon: with
# an escape hatch the agent decides when the rule applies, which is the opposite of the
# point. The rule is absolute and the answer to "the user told me to" is to have the user
# run it.
#
# Sibling of migrations-only.sh (the *how* of schema change) and no-db-in-api.sh (the
# *where* of database access). This one is about *who decides*.
set -uo pipefail

payload="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
[[ -z "${cmd// }" ]] && exit 0

block() {
  # $1 = rule title, $2 = what to do instead
  cat >&2 <<EOF
Blocked by .claude/hooks/ask-first.sh — $1

  command: $(printf '%s' "$cmd" | head -c 300)

$2

Stop here. Show the user the exact command and ask them to run it (they can type
\`! <command>\` in the prompt). Do not retry it yourself, and do not work around the
guard with another tool or a different spelling.

Note: this guard reads the whole command line, so a script that merely *contains* one of
these words in a string trips it. When that happens the fix is the Write tool, not a
re-spelling of the command.
EOF
  exit 2
}

# A command "starts" where a new shell word can begin: line start, or after ; & | ( \` $(,
# then any number of prefixes in any order — inline environment assignments (FOO=bar) and
# wrapper commands (sudo, env, time, nohup, xargs). Anchoring on this is what keeps
# `pnpm rm` and `format` from being mistaken for `rm`, while still catching `git commit`
# inside a quoted commit message.
#
# The prefix run is not cosmetic, and it took two tries. Without assignments at all,
# `FOO=1 rm -rf x` matched nothing and sailed past every guard below. With assignments
# only *before* the wrapper group, `env FOO=1 rm -rf x` still did — the two can interleave
# in either order, so the group has to repeat rather than sit in a fixed sequence. Both
# holes were found by test cases rather than by reading the regex, which is the whole
# argument for the fixture file: a guard nobody probes is a guard nobody has checked.
start='(^|[;&|(`]|\$\()[[:space:]]*((sudo|env|time|nohup|xargs)[[:space:]]+([-][^[:space:]]+[[:space:]]+)*|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'

# ---------------------------------------------------------------------------------------
# 1. Commits and pushes
# ---------------------------------------------------------------------------------------
if printf '%s' "$cmd" | grep -Eq "${start}git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(commit|push|filter-repo|filter-branch|rebase|merge|cherry-pick|revert|am|tag|remote[[:space:]]+(add|remove|rm|set-url))\b"; then
  block "no commits, pushes or history changes by the agent" \
"Committing and pushing are the user's call. Stage nothing, commit nothing. Report the
change set and the suggested commit message, then wait."
fi
if printf '%s' "$cmd" | grep -Eq "${start}gh[[:space:]]+(pr[[:space:]]+(create|merge|close)|repo[[:space:]]+(create|edit|delete|rename|archive|fork)|release[[:space:]]+(create|delete)|api[[:space:]]+(-X|--method)[[:space:]]+(POST|PUT|PATCH|DELETE))\b"; then
  block "no writes to the remote repository by the agent" \
"Anything that changes GitHub state — PRs, releases, repository settings, mutating API
calls — is the user's call. Read-only gh commands (view, list, GET) are fine."
fi

# ---------------------------------------------------------------------------------------
# 2. Installing tools or packages, or running a tool fetched on the fly
#    Allowed: bare `pnpm install` / `npm ci` / `npm install` (restores the lockfile).
# ---------------------------------------------------------------------------------------
if printf '%s' "$cmd" | grep -Eq "${start}(brew[[:space:]]+(install|reinstall|upgrade|tap|cask)|port[[:space:]]+install|apt(-get)?[[:space:]]+install|yum[[:space:]]+install|dnf[[:space:]]+install|pip[0-9.]*[[:space:]]+install|pipx[[:space:]]+install|uv[[:space:]]+(pip[[:space:]]+install|tool[[:space:]]+install|add)|cargo[[:space:]]+install|gem[[:space:]]+install|go[[:space:]]+install|conda[[:space:]]+install|npx|pnpx|bunx|pnpm[[:space:]]+dlx|npm[[:space:]]+exec|yarn[[:space:]]+dlx)\b"; then
  block "no new tools installed or fetched-and-run without explicit authorisation" \
"Installing a tool or running one straight from a registry (npx, pnpm dlx, brew install,
pip install, curl | sh …) changes the user's machine. Ask first, naming the tool, its
version, and why it is needed."
fi
# Global or additive package installs. Bare `pnpm install`/`npm install`/`npm ci` pass.
if printf '%s' "$cmd" | grep -Eq "${start}(pnpm|npm|yarn|bun)[[:space:]]+(add|i|install|link|dedupe|update|up|upgrade|remove|rm|uninstall|un)([[:space:]]+[^[:space:]]+)*[[:space:]]+(-g|--global|-D|--save-dev|-P|--save-prod|-O|--save-optional|-w|--workspace-root|@?[a-z0-9][^[:space:]]*)" \
   && ! printf '%s' "$cmd" | grep -Eq "${start}(pnpm|npm|yarn|bun)[[:space:]]+(i|install|ci)([[:space:]]+--(frozen-lockfile|prefer-offline|offline|no-frozen-lockfile|ignore-scripts))*[[:space:]]*($|[;&|)])"; then
  block "no dependency changes without explicit authorisation" \
"Adding, removing or upgrading a package changes package.json and the lockfile, and a
global install changes the machine. Restoring the existing lockfile (bare pnpm install)
is fine. Ask first, naming the package and version."
fi
# Piping a download into a shell.
if printf '%s' "$cmd" | grep -Eq "(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh\b"; then
  block "no piping downloads into a shell" \
"This installs and runs code from the network in one step. Ask first."
fi

# ---------------------------------------------------------------------------------------
# 3. Database migrations and other live database changes
#    Generating a migration (db:generate) is fine; applying it is not.
# ---------------------------------------------------------------------------------------
if printf '%s' "$cmd" | grep -Eq "db:(migrate|push|role-password)|drizzle-kit[[:space:]]+(migrate|push|up|drop)|psql[^;|&]*[[:space:]]-f[[:space:]]+[^[:space:]]*migrations/"; then
  block "no migrations applied by the agent" \
"Edit src/server/db/schema/ and run pnpm db:generate, read the SQL it wrote, then STOP.
Tell the user which migration file is ready and what it does, and ask them to apply it."
fi

# ---------------------------------------------------------------------------------------
# 4. Deleting files, or discarding work
# ---------------------------------------------------------------------------------------
if printf '%s' "$cmd" | grep -Eq "${start}(rm|rmdir|unlink|shred|srm|trash)\b|\bfind\b[^;|&]*(-delete\b|-exec[[:space:]]+(rm|unlink)\b)|\|[[:space:]]*xargs[[:space:]]+([-][^[:space:]]+[[:space:]]+)*(rm|unlink)\b|>[[:space:]]*/dev/null[[:space:]]+<|\bmv\b[^;|&]*[[:space:]]/dev/null"; then
  block "no file deletion by the agent" \
"Deleting is the user's call, including temp files and build output. Name the paths and
why they should go, and ask."
fi
if printf '%s' "$cmd" | grep -Eq "${start}git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(rm|clean|stash[[:space:]]+(drop|clear|pop)|branch[[:space:]]+(-D|-d|--delete)|reset[[:space:]]+(--hard|--merge)|checkout[[:space:]]+(--[[:space:]]|\.)|restore\b|worktree[[:space:]]+remove)"; then
  block "no git operations that discard files or work" \
"git rm / clean / reset --hard / checkout -- / restore / stash drop delete content that
may not be recoverable. Ask first, naming what would be lost."
fi

exit 0
