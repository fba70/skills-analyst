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

### Object storage

One R2 bucket, `skills-foundry` (EU jurisdiction — the S3 endpoint host needs the `.eu`
part or you get `NoSuchBucket`). Prefixes by trust level: `public/`, `quarantine/`,
`drafts/`. Keys are content-addressed — `sha256/<hash>/<file>` — so the key *is* the hash
the verdict covers, and integrity is structural rather than checked.

Every object is private. Access is mediated by the app, so bucket-level access is not the
security boundary and the three-bucket split in Doc 3 is **not** needed at this stage.

> **NEVER attach a public custom domain to `skills-foundry`.**
>
> R2 grants public access per *bucket*, never per prefix. A domain on this bucket would
> expose `quarantine/` — content we assume is malicious — and `drafts/`, which is private
> tenant data. Before any CDN-served public serving exists, the public content moves to
> its own bucket. This is the one storage rule that cannot be worked around later.

Until then, serving bytes is a choice between a proxy route (simple; 4.5 MB response cap
and Vercel egress) and short-TTL presigned GET URLs (no egress, but the URL is a bearer
token until it expires — public corpus only, never private-tier).

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

### ~~Tenant isolation, layer 2~~ — done (migration 0002)

Both layers are live. Layer 1 is the DAL; layer 2 is Postgres itself:

- The app connects as **`app_runtime`** (NOSUPERUSER, **NOBYPASSRLS**), not `neondb_owner`
  — the owner carries BYPASSRLS, so policies written for it would silently do nothing.
- `src/server/dal/scope.ts` opens a transaction and issues `SET LOCAL app.org_id` on
  every org-scoped read and write. Use `withOrgScope` / `withPublicScope`;
  `withExplicitOrgScope` is for background work with no session and stays `server-only`.
- Policies on all seven corpus tables: `org_id IS NULL` (public) OR
  `org_id = current_setting('app.org_id', true)`.

`pnpm db:verify-rls` proves it end to end: anonymous sees only public, org A never sees
org B, and a cross-org write is refused. Run it after any schema change that adds an
org-scoped table — **and add the policy in the same migration**, because a new table
without one is invisible to the app rather than merely unprotected.

The role's password is deliberately **not** in a migration (those get committed).
`pnpm db:role-password` sets it and rewrites `DATABASE_URL` in `.env`.

### System admin

A **system admin** is not an organisation role. Org roles (owner, member) say what
someone may do inside their own tenant; this says what they may do to the platform — see
every user, run ingestion, change policy.

- The role lives on `user.role`, the field Better Auth's admin plugin already checks, so
  the two agree rather than competing. The constant is `src/server/auth/roles.ts`, a leaf
  module with no imports (the DAL reaches `next/navigation`, and `auth` → `dal/admin` →
  `dal/session` → `auth` would be a cycle).
- `ADMIN_EMAILS` grants the role on sign-up, so a fresh deployment has someone who can
  reach Settings without a hand-edited database. `pnpm admin:grant <email> [--revoke]` is
  the way back in after a lockout.
- `/settings` is admin-only three times over: the sidebar only renders the link for
  admins, the page `notFound()`s for everyone else (a non-admin has no reason to learn the
  route exists), and **every server action re-checks `requireAdmin()`** — an action is a
  POST endpoint, so a page guard protects the view, not the operation.
- Tabs today: **Ingestion** (bounded manual runs of crawl / promote / sync / validate) and
  **Users** (all users, grant or revoke admin, ban). More tabs go here.

### Admin settings — the knobs must become data, not code

The `/settings` shell exists; the policy still does not live in it. Every decision about
*what gets fetched and how it is judged* is currently a constant in
`src/server/crawl/policy.ts` (and the analyzer thresholds in `src/server/validation/`).
That is deliberate for now — one place to change, easy to reason about — but it is not
where they belong.

Once ingestion works end to end, the real questions become operational: what can actually
be fetched, how good is it, how much is duplicated, what is worth analysing. Those are
answered by tuning, repeatedly, against a live corpus — and tuning through a redeploy is
too slow to learn anything. Doc 3 already makes this argument for sync cadence
("cadence is data, not deploys"); it applies to the whole policy surface.

What needs to move into a settings table with an admin UI, audited through `events` like
any other state change:

- **Discovery:** path exclusions, marker-count cap before review, star/recency floors,
  which shards to crawl, whether forks are ever included.
- **Promotion:** auto-promote vs hold-for-review thresholds.
- **Validation:** analyzer severity thresholds, what blocks vs warns, quality-score
  weights, re-scan triggers.
- **Duplicates:** the near-duplicate similarity threshold.
- **Spend:** per-analyzer model choice and budget caps (RC.2 needs this anyway).

Keep new policy constants in `policy.ts` rather than scattering them, so this becomes a
migration of one module instead of an archaeology exercise.

### Platform stats on /dashboard — a gap in the specs

Not in Doc 2 or Doc 3, and worth adding after the core features land. The specs cover two
audiences and miss a third:

- **operators** — source health (R1.7), loop observability (R6.4), and the four dashboards
  in Doc 3 §Observability;
- **researchers** — corpus statistics as an API/dataset export (R3.7, P2);
- **users** — nothing. `/dashboard` is currently empty.

What a user needs from a trust-first registry is the corpus at a glance, and it differs
from what an operator needs: not queue depth and rate-limit headroom, but *how much is
here, how good is it, and how much can I actually use*. Roughly:

- skills indexed, and how many sources they came from;
- how many passed validation, how many are quarantined, quality-score distribution;
- licence mix — mirrored vs metadata-only, since that changes what a user may do with a
  result;
- duplicate clusters, once R1.4 near-duplicate detection exists;
- freshness: last sync, and corpus staleness against the 24 h target (R7.4).

Every number is already derivable from `skills`, `skill_versions`, `verdicts` and
`events` — a query and a component, not new plumbing. Keep the aggregates cheap enough to
compute on request before reaching for a materialised view.

### Giant repositories need the tarball path

`GET /git/trees/{sha}?recursive=1` truncates above ~100k entries, and the connector throws
rather than proceeding — silence there would mean a partial corpus that looks complete.

That is correct, but it means a curator can approve a monorepo and the sync still fails:
`liferay/liferay-portal` is approved and holds real Cursor skills, and cannot currently be
fetched. Two ways out, neither built yet:

- **Tarball** — `GET /repos/{o}/{r}/tarball/{ref}` is one call for the whole repository and
  has no entry limit. Costs bandwidth and needs a tar reader.
- **`includePaths` at approval time** — let the curator narrow to `workspaces/` and reuse
  the existing tree call. Cheaper, and the review UI already shows the sample paths that
  would tell them what to type.

The second is the smaller change and probably the right first move.

### Smaller ones

- **Neon backoff.** Wrap DAL queries in exponential backoff with jitter. Neon documents
  this as required for cold starts, not optional.
- **GitHub OAuth.** Doc 3 wants it as a login path for identity attribution. Additive —
  the `account` table already carries it.
- **Mail reaches only one address in production.** Resend is wired and working, but no
  domain is verified, so `MAIL_FROM` is unset and sends fall back to the shared
  `onboarding@resend.dev`, which delivers **only to the Resend account owner**. Anyone
  else gets a 403 and no email. Fix: verify `send.truffalo.ai` in Resend (subdomain, so
  the apex Google Workspace MX and GoDaddy SPF-merge record stay untouched), then set
  `MAIL_FROM` in Vercel. Until then, sign-in works for one address only.
- **A failed send still shows the user "code sent".** Better Auth runs
  `sendVerificationOTP` as a background task and swallows the throw, so a delivery failure
  is visible in the logs (`[mail] …`) but not in the UI.
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
