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

## Scripts

| | |
|---|---|
| `pnpm dev` | dev server |
| `pnpm build` / `pnpm start` | production build and serve |
| `pnpm lint` / `pnpm typecheck` | checks |
| `pnpm db:generate` | write a migration from the Drizzle schema |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:studio` | browse the database |

The database changes **only** through committed files in `migrations/`: edit the schema,
`db:generate`, read the SQL, `db:migrate`, commit. `drizzle-kit push` and hand-typed DDL
are both blocked — see `CLAUDE.md`.

## Where things live

```
src/app/          routes: public, (auth), (protected)
src/components/   ui/ (shadcn, vendored), layout/, auth/
src/server/       server-only: auth, db, dal, mail
src/proxy.ts      Next 16's renamed middleware
migrations/       generated SQL, committed
```

Database access happens only in `src/server/**`, called from server components and
server actions. API routes do not touch the database; a Claude Code hook and an ESLint
rule both enforce that.
