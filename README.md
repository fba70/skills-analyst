# Skills Foundry

Ingest agent skills from many sources, validate them, mine what good ones have in
common, and feed that back into building new ones. **The loop is the product.**

Specs live in `specs/core/`. Working agreements and rules for this repo are in
`CLAUDE.md`.

## Run it locally

Requires Node 24+, pnpm, and a Neon Postgres database.

```bash
pnpm install
cp .env.example .env        # then fill it in, see below
pnpm db:migrate             # creates the auth tables
pnpm dev                    # http://localhost:3000
```

`.env` needs three values:

- `DATABASE_URL` — Neon's **pooled** endpoint. The app uses this.
- `DATABASE_URL_UNPOOLED` — the same database with `-pooler` dropped from the host.
  Migrations only; the pooler cannot run `CREATE INDEX CONCURRENTLY`.
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.

## Signing in

Passwordless: enter an email, get a six-digit code. There is no mail provider wired up
in development — the code is printed to the terminal running `pnpm dev`:

```
┌──────────────────────────────────────────────┐
│ Skills Foundry — Sign in                      │
│ to:   you@example.com                        │
│ code: 422486                                 │
└──────────────────────────────────────────────┘
```

The first sign-in creates the account and a personal workspace.

## What works today

Ingest → validate → analyze → build runs end to end.

| | |
|---|---|
| `/` | corpus statistics, live |
| `/skills` | public registry — provenance, licence, verdicts, quality score, download |
| `/archetypes` | what a good skill in each category looks like, mined from the corpus |
| `/faq` | what every score, badge and category means — generated from the code |
| `/build` | archetype-driven skill builder (sign-in required) |
| `/settings` | admin: ingestion, taxonomy, quarantine, sources, takedowns |

A requirement-by-requirement status audit is in
`specs/core/02-requirements-spec.md` §10b. The short version: the forward path is built,
and **closing the loop (§7.6) is not** — a created skill cannot yet be published back.

## Scripts

| | |
|---|---|
| `pnpm dev` | dev server |
| `pnpm build` / `pnpm start` | production build and serve |
| `pnpm lint` / `pnpm typecheck` | checks |
| `pnpm db:generate` | write a migration from the Drizzle schema |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:studio` | browse the database |

**Corpus pipeline** — each stage bounded and resumable:

| | |
|---|---|
| `pnpm pipeline --loop 60` | sync → validate → fingerprint → signatures → cluster |
| `pnpm seed --repos \| --lists` | curated discovery |
| `pnpm submit <repo>` | add one source |
| `pnpm crawl \| promote \| sync \| validate \| duplicates` | individual stages |
| `pnpm structures --extract 500` | structural fingerprints, free |
| `pnpm archetypes --mine-all` | mine archetypes, free |
| `pnpm rescan --status \| --run N` | re-verdict after an analyzer bump, free |

**Two commands spend money**, both opt-in and capped: `pnpm taxonomy --sample N`
(classification, ~$0.29 per 100) and `pnpm validate --consistency` (the R2.3 audit).
`pnpm verify:builder` also makes two real model calls.

**Verification** — each proves a property that was once broken:

```
pnpm verify:revocation   pnpm verify:export     pnpm verify:takedown
pnpm verify:otp          pnpm verify:db-retry   pnpm verify:builder
pnpm validate:verify     pnpm verify:lists      pnpm db:verify-rls
```

The database changes **only** through committed files in `migrations/`: edit the schema,
`db:generate`, read the SQL, `db:migrate`, commit. `drizzle-kit push` and hand-typed DDL
are both blocked — see `CLAUDE.md`.

## Where things live

```
src/app/
  page.tsx           landing, with live corpus statistics
  (public)/          registry, archetypes, FAQ — readable with no account
  (protected)/       dashboard, build, settings — session required
  api/               auth, cron, skill download
src/components/      ui/ (shadcn, vendored), registry/, archetypes/, builder/, settings/
src/lib/             client-safe leaves: quality, capabilities, section roles, FAQ anchors
src/server/          server-only
  ingest/ crawl/ connectors/     getting skills in
  validation/                    the trust boundary
  analytics/ taxonomy/           fingerprints, dedup, archetypes, categories
  builder/                       archetype-driven authoring
  compliance/                    takedowns
  dal/ db/ auth/ mail/ storage/
src/proxy.ts         Next 16's renamed middleware
migrations/          generated SQL, committed
```

Database access happens only in `src/server/**`, called from server components and
server actions. API routes do not touch the database; a Claude Code hook and an ESLint
rule both enforce that.
