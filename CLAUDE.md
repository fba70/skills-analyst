@AGENTS.md

# Skill Foundry

Platform that ingests agent skills, validates them, mines structural archetypes from
the corpus, and feeds that back into a builder and an assistant. **The loop is the
product.**

Specs are the source of truth, in this order:

- `specs/core/01-business-concept.md` — vision, tiers, licensing
- `specs/core/02-requirements-spec.md` — functional requirements (R1.x … R7.x, RC.x)
- `specs/core/03-implementation-spec.md` — architecture and platform decisions
- `specs/core/04-source-ingestion-analysis.md` — sources, licence chain, crawl waves

Read the relevant spec before designing anything. If the code and a spec disagree,
that is a bug in one of them — say which.

## Stack

Local development only right now. No deploy, no CI.

| | |
|---|---|
| Package manager | pnpm (only) |
| Framework | Next.js 16.3.3, App Router, `src/`, Turbopack |
| React | 19.2.8 |
| Styling | Tailwind CSS v4 + shadcn/ui (radix base, vendored into `src/components/ui`) |
| Theme | tweakcn "Northern Lights", CSS vars in `src/app/globals.css`, fonts wired in `src/app/layout.tsx` |
| Auth | better-auth **1.7.2, exact pin** — plugins: emailOTP, admin, organization, localization, nextCookies |
| DB | Neon Postgres via `pg` over TCP + Drizzle ORM |
| Theme switch | next-themes |

**Pin better-auth exactly.** Core and plugins must be one version, bumped in one edit —
two copies of `@better-auth/core` crash at startup.

## Layout

```
src/
  app/
    page.tsx                  public home
    (auth)/                   sign-in, sign-up — bounces a live session to /dashboard
    (protected)/              server-guarded group: layout calls requireSession()
    api/auth/[...all]/        Better Auth handler — the only DB-touching route
  components/
    ui/                       shadcn, vendored, ours to edit
    layout/                   app sidebar and its rows
    auth/                     the OTP form
  lib/auth-client.ts          browser auth client (plugins mirror the server)
  server/                     server-only. Nothing here may reach the client.
    auth/                     betterAuth config + personal-org bootstrap
    db/                       pg pool, drizzle instance, schema/
    dal/                      session and org access — the auth boundary
    mail/                     one transport interface; dev prints OTPs to the terminal
  proxy.ts                    Next 16's renamed middleware. Optimisation only.
migrations/                   generated SQL, committed
```

## Rules

### Database access

**No database access from API routes.** Everything under `src/app/api/**` is barred from
`@/server/db`, `drizzle-orm` and `pg`. Queries live in `src/server/**` and are called
from server components and server actions, where the DAL resolves the session and the
org. Only `src/app/api/auth/**` is exempt — Better Auth owns its own endpoints.

Enforced twice: `.claude/hooks/no-db-in-api.sh` (PreToolUse, blocks the edit) and a
`no-restricted-imports` block in `eslint.config.mjs` (fails lint and build).

Every module under `src/server/` starts with `import "server-only"`.

### Auth boundary

`src/server/dal/session.ts` is the boundary. `getSession()` is request-cached;
`requireSession()` redirects. Every protected page and **every server action** resolves
it for itself — `src/proxy.ts` only checks that a cookie exists, and a POST to a server
action can reach the handler without passing a proxy matcher.

Any function that takes an explicit `organizationId` stays in a `server-only` module and
checks membership itself. Never `"use server"`.

Sign-in is passwordless: email plus a 6-digit code, same flow for sign-up. Every user
gets a personal organization on creation, and every new session starts with it active.

### Migrations — the only way the database changes

Every schema change is a committed file in `migrations/`. Nothing is typed at a psql
prompt, and `drizzle-kit push` is banned repo-wide (it proposes destructive phantom
drops on partial and expression indexes, and this schema has both).

```
# 1. edit src/server/db/schema/
pnpm db:generate     # writes migrations/NNNN_name.sql + meta snapshot
# 2. READ the generated SQL before applying it
pnpm db:migrate      # applies on DATABASE_URL_UNPOOLED (direct endpoint)
# 3. commit migrations/ together with the schema change
```

Roles, grants and RLS policies are schema too: they go in a hand-written `.sql` file in
`migrations/`, registered in `migrations/meta/_journal.json`. Never a live `GRANT`.

`.claude/hooks/migrations-only.sh` blocks `drizzle-kit push` and hand-typed DDL
(CREATE / ALTER / DROP / TRUNCATE / RENAME, GRANT / REVOKE, roles, RLS). Reads and
`SELECT`s are not blocked.

**Two endpoints, on purpose.** `DATABASE_URL` is Neon's pooled endpoint and is what the
app uses. `DATABASE_URL_UNPOOLED` is the same database on the direct endpoint (host
without `-pooler`) and is only for migrations and `CREATE INDEX CONCURRENTLY`, which
the pooler cannot run.

Better Auth's table shapes are not guesswork: re-derive them with `getAuthTables()` from
`better-auth/db` whenever a plugin is added or the version moves, then generate a
migration. Do not hand-tune those columns.

## Open TODOs carried from the specs

### Tenant isolation, layer 2 (do this with the first org-scoped table)

Doc 3 C4 wants two layers. Layer 1 — the DAL — is built: `src/server/dal/` resolves the
org from the session and no route handler can reach the database. Layer 2 is the
database backstop, and it is not built yet, because it has nothing to protect until the
first table with an `org_id` column exists. Three pieces, all in one migration:

1. **A least-privilege runtime role.** The app currently connects as `neondb_owner`,
   which is a superuser-ish role carrying `BYPASSRLS` — policies would simply not apply
   to it. Create `app_runtime`, grant it DML on the app tables and nothing more, and
   point the app's `DATABASE_URL` at it. Migrations keep using the owner role.
2. **`SET LOCAL app.org_id` in every DAL entry point.** Each entry point opens a
   transaction and sets the current org on it. This only works inside a transaction —
   which is the reason the stack uses `pg` over TCP instead of Neon's HTTP driver.
3. **Policies on every org-scoped table:** allow the row when `org_id IS NULL` (public
   corpus) or `org_id = current_setting('app.org_id')::uuid`.

Policy coverage on all org-scoped tables is the launch gate for the first private-corpus
tenant. Ship it with the schema, not after — a backstop bolted on under deadline is not
a backstop.

### Smaller ones

- **Neon backoff.** Wrap DAL queries in exponential backoff with jitter. Neon documents
  this as required for cold starts, not optional.
- **GitHub OAuth.** Doc 3 wants it as a login path for identity attribution. Additive —
  the `account` table already carries it.
- **Real mail transport.** `src/server/mail/` prints codes to the terminal. Add a
  provider transport there and nothing else changes.
- **Orphaned organizations.** Deleting a user cascades their `member` row but leaves an
  organization nobody belongs to. `deleteUser` is disabled, so this is not live yet.

## Commands

```
pnpm dev            # http://localhost:3000
pnpm build
pnpm lint
pnpm typecheck
pnpm db:generate | db:migrate | db:studio
```
