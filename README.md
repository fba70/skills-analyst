# Skills Foundry

Ingest agent skills from many sources, validate them, mine what good ones have in
common, and feed that back into building new ones. **The loop is the product.**

Working agreements, architecture and the reasoning behind every non-obvious decision are
in `CLAUDE.md` — read it first. Specs live in `specs/core/` and what is left to build is
in `specs/debt.md`; both are local only.

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

`LLM_ENABLED` is a fourth value worth knowing about, and **unset means off**: with it unset
nothing in the app calls a language model, and the surfaces that would — generation,
interview, distill, evals, the optimiser, parameter detection, similarity — are not rendered.
Everything else is unaffected: sign-up, sign-in, registry search, skill pages, writing a skill
by hand, validation, publishing and export. Set `LLM_ENABLED=1` locally to work on those
features or to run the metered corpus scripts; leave it unset on a deployment that should
spend no tokens.

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

Ingest → validate → analyze → build → publish → telemetry runs end to end. A skill
authored here is published back through the same pipeline an externally synced one goes
through, and what happened while authoring it feeds the next archetype mine.

| | |
|---|---|
| `/` | corpus statistics, live |
| `/skills` | public registry — provenance, licence, verdicts, quality score, download |
| `/skills/<slug>/<hash>` | citable per-version permalink |
| `/archetypes` | what a good skill in each category looks like, mined from the corpus |
| `/tools` | which skills use which tools — a third axis beside function and domain |
| `/wanted` | what people search for and the corpus does not answer |
| `/faq` | what every score, badge and category means — generated from the code |
| `/build` | the workbench: compose, interview, distill, evals, export (sign-in required) |
| `/curate` | per-category maintainers: the flag queue they can act on, and endorsement |
| `/capture` | expertise-capture campaigns (Team) |
| `/settings` | admin: ingestion, taxonomy, quarantine, flags, takedowns, spend, plans, loop |
| `/api/mcp` | seven MCP tools for agents — token-gated, rate-limited |
| `/api/v1` | public metadata API and dataset export |

What is **not** built, with priority, is in `specs/debt.md`.

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

**Verification** — 55 suites, each proving a property that was once broken, and each
reproducing the failure before asserting the fix. `package.json` lists them all; start
with:

```
pnpm db:audit            pnpm verify:tree       pnpm verify:models
pnpm verify:blocks       pnpm verify:archetypes pnpm verify:outcomes
pnpm db:verify-rls       pnpm validate:verify
```

The database changes **only** through committed files in `migrations/`: edit the schema,
`db:generate`, read the SQL, `db:migrate`, commit. `drizzle-kit push` and hand-typed DDL
are both blocked — see `CLAUDE.md`.

## Where things live

```
src/app/
  page.tsx           landing, with live corpus statistics
  (public)/          registry, archetypes, tools, wanted, FAQ — readable with no account
  (protected)/       dashboard, build, curate, capture, settings — session required
  api/               auth, cron, download, mcp, v1, interview, billing webhook
src/components/      ui/ (shadcn, vendored), registry/, archetypes/, builder/, settings/
src/lib/             client-safe leaves: quality, capabilities, section roles, FAQ anchors
src/server/          server-only
  ingest/ crawl/ connectors/     getting skills in
  validation/                    the trust boundary
  analytics/ taxonomy/           fingerprints, blocks, dedup, archetypes, categories
  builder/ interview/ distill/   the workbench
  evals/                         skill CI, trigger lab, with/without matrix, optimiser
  curation/ compliance/          flags, maintainers, takedowns
  billing/ mcp/ notifications/   entitlements, spend, the agent surface, watch feeds
  dal/ db/ auth/ mail/ storage/
src/proxy.ts         Next 16's renamed middleware
migrations/          generated SQL, committed
```

Database access happens only in `src/server/**`, called from server components and
server actions. API routes do not touch the database; a Claude Code hook and an ESLint
rule both enforce that.
