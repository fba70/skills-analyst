@AGENTS.md

# Skills Foundry

Platform that ingests agent skills, validates them, mines structural archetypes from
the corpus, and feeds that back into a builder and an assistant. **The loop is the
product.**

**What to build next is in `specs/plan.md`** — six milestones, twenty-three steps. Start
there. It is local only, like everything under `specs/`.

Specs are the source of truth for requirements, in this order (local only, gitignored):

- `specs/core/01-business-concept.md` — vision, tiers, licensing
- `specs/core/02-requirements-spec.md` — functional requirements (R1.x … R7.x, RC.x)
- `specs/core/03-implementation-spec.md` — architecture and platform decisions
- `specs/core/04-source-ingestion-analysis.md` — sources, licence chain, crawl waves
- `specs/core/06-workbench-and-km-extensions.md` — the block model and the workbench (RW.x, RK.x) — built
- `specs/core/07-parameters-tools-and-the-intelligent-designer.md` — parameters, tools, the designer (RD.x) — in progress

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
    (public)/                 registry — readable with no account (R8.1)
    (protected)/              server-guarded group: layout calls requireSession()
    api/auth/[...all]/        Better Auth handler — the only DB-touching route
    api/skills/[slug]/download/  skill export (R8.2) — calls src/server, never the db
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

### Hard rules — the agent proposes, Boris decides

Set on 2026-09-06 and enforced by `.claude/hooks/ask-first.sh` on every Bash call. The
hook blocks the command and tells the agent to prompt the user. **A blocked command is not
a bug to route around** — not with another tool, another spelling, a script, or a subagent.

1. **No commits, no pushes.** The agent stages nothing and commits nothing. It reports the
   change set and a suggested message, and the user commits. Same for anything that writes
   to GitHub: PRs, releases, repository settings, history rewrites, force-pushes.
2. **No new tools without explicit authorisation.** No `brew install`, `pip install`,
   global `npm`/`pnpm` installs, `npx` / `pnpm dlx`, `curl | sh`, and no adding, removing or
   upgrading a project dependency. Bare `pnpm install` (restore the lockfile) is fine. Ask
   first, naming the tool, its version and why.
3. **No migrations applied by the agent.** Edit the schema, run `pnpm db:generate`, read
   the SQL, then stop and ask the user to apply it. `db:role-password` and `drizzle-kit
   push` are covered too (`push` is banned outright, see below). **There is no override**:
   one was built and removed the same afternoon, because an escape hatch lets the agent
   decide when the rule applies, which is the opposite of the point.
4. **No file deletion.** No `rm`, `rmdir`, `find -delete`, `git rm`, `git clean`,
   `git reset --hard`, `git checkout --`, `git restore`, `git stash drop`. Temp files and
   build output included. Name the paths and ask.
5. **No database calls from API routes.** Every query lives in `src/server/**` and is
   called from a server component or server action. Route handlers under `src/app/api/**`
   MUST NOT import `@/server/db`, `drizzle-orm` or `pg`; only `src/app/api/auth/**` is
   exempt. Enforced by `.claude/hooks/no-db-in-api.sh` and ESLint — detail in the next
   section.

Authorisation is per action, not per session: "yes, install X" does not cover Y, and
"yes, commit this" does not cover the next commit.

### Hand-offs are a numbered list at the end, never prose

Every hard rule above ends the same way: the agent stops and Boris runs something. So every
response that needs him to act **must close with one block** — the last thing in the message —
holding the commands in the order they have to run, one per line, copy-pasteable, with a
one-line reason each. Migrations, backfills, installs, commits, drops, ledger fixes: all of it,
in one place.

Not scattered through the explanation. A hand-off spread across four paragraphs is a hand-off
where step two gets missed, and the failure is not theoretical: `draft_blocks` was applied and
then its migration files deleted, because the tidy-up and the apply were two commands in two
different paragraphs and the tidy-up was read as replacing the apply. That left the database
holding two tables no migration on disk could create — caught only because `pnpm db:audit`
counts applied against on-disk.

The reasoning still belongs in the body. The **commands** belong at the end, once, in order.

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

**Drizzle owns the whole object, RLS included** *(set 2026-09-06)*. A migration file is
`drizzle-kit` output and nothing else — no hand-written SQL appended to it. That includes
row-level security: declare a policy with `pgPolicy(...)` in the table's own definition and
`db:generate` emits the `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` for you. Verified
on `skill_blocks` (migrations 0024 and 0025): drizzle produced exactly the two statements
that had been written by hand, and nothing else — no `CREATE ROLE`, no drops.

Why it matters beyond tidiness: a hand-appended policy is a **second source of truth**. The
schema said one thing, a `.sql` file said another, and nothing could compare them, so a
policy could be forgotten in a migration or drift from the model with no way to notice.
Declaring it on the table also gets the property migration 0006 had to argue for in a
comment — the policy lands in the same migration as the table, and RLS defaults to deny, so
a policy that arrives later leaves a window where `app_runtime` reads zero rows.

**No `GRANT` is needed and none should be written.** Migration 0002 set
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
app_runtime`, so every table a migration creates is already reachable. The proof is
migration 0006: it created `skill_structures` with no grant at all and mining has read it
ever since. The explicit grants in 0018–0020 are redundant belt-and-braces and are not the
pattern to copy. Never a live `GRANT`.

Migrations 0002–0020 keep their hand-written policy blocks — they are applied history and
re-declaring them in the schema would make `drizzle-kit` propose creating policies that
already exist. New tables go the Drizzle way.

**The only scripts allowed to change the database are data scripts.** Backfills and
dictionary population, written through the Drizzle query builder — `scripts/fix-slugs.mts`
is the model: it imports `db` and the schema, and is idempotent so a re-run is a no-op.
Audited on 2026-09-06: **no DDL, `GRANT` or `REVOKE` is executed from anywhere in `src/` or
`scripts/`.** The one exception is `scripts/set-runtime-role-password.ts`, which issues a
live `ALTER ROLE … PASSWORD` because a password cannot be committed to a migration, and it
builds the statement server-side with `format(%I, %L)` since `ALTER ROLE` takes no bind
parameters.

`.claude/hooks/migrations-only.sh` blocks `drizzle-kit push` and hand-typed DDL
(CREATE / ALTER / DROP / TRUNCATE / RENAME, GRANT / REVOKE, roles, RLS). Reads and
`SELECT`s are not blocked. `.claude/hooks/ask-first.sh` additionally stops the agent
*applying* a migration — generate it, read the SQL, then hand it to Boris.

**Two endpoints, on purpose.** `DATABASE_URL` is Neon's pooled endpoint and is what the
app uses. `DATABASE_URL_UNPOOLED` is the same database on the direct endpoint (host
without `-pooler`) and is only for migrations and `CREATE INDEX CONCURRENTLY`, which
the pooler cannot run.

Better Auth's table shapes are not guesswork: re-derive them with `getAuthTables()` from
`better-auth/db` whenever a plugin is added or the version moves, then generate a
migration. Do not hand-tune those columns.

## Where things stand — audited 2026-09-06

Snapshot for picking this up cold. Numbers move; the shape does not. Full requirement-level
audit is **`specs/core/02-requirements-spec.md` §10b** — that table is the source of truth,
this is the summary. The ordered plan is §10, and **Phase A of it is complete**.

Run `pnpm db:audit` for the live version of the table below; it is free, read-only, and is
where these numbers came from.

| | |
|---|---|
| Corpus | 49,134 indexed · 47,855 canonical · 1,053 quarantined |
| Sources | **888 synced of 896** — ingestion is done; the source table is deduplicated (migration 0021) |
| Discovery | 1,998 candidates awaiting a decision |
| Taxonomy | **46,489 labelled**, 103,588 assignments · 163 held below the floor · 1,327 unlabelled |
| Validation | 443,222 verdicts, all current |
| Archetypes | 13 categories at **v9 (review v10)**, miner **3.0.0** · 91 earlier rows kept as history · public at `/archetypes` |
| Blocks | **1,620,316 typed spans** at extractor 2.0.0 across 50,870 of 50,965 documents · now mined and published · **extractor is 2.1.0 since 2026-09-10** (tool references) and the re-extract has not run — every stored fingerprint reads as stale until `pnpm structures --extract 500 --drain` |
| Embeddings | 47,854 of 47,855 canonical skills · pgvector 0.8.6, HNSW cosine, 1,536 dimensions · $0.08 |
| Lifecycle | **new (A4)** — derived second axis; battle-tested unreachable by construction |
| Entitlements | **new (A5)** — three plans; the trust surfaces cannot be gated at all |
| Builder | live at `/build` · **a draft is typed blocks and the body is their render (C1)** · block editing, revisions and a no-model scaffold path (C1b, R4.6, R4.7) · **Interview mode, five techniques, typed candidates accepted or rejected (C2, RW.4, R5.1, R5.4)** · block-level archetype deviations (R4.3) |
| MCP | live at `/api/mcp` · six tools, token-gated, rate-limit scope now follows the plan |
| Schema | 51 migrations (0000–0050) · `pnpm db:audit` has the live table count |
| Spend, cumulative | **$31.70** — $31.52 taxonomy, $0.10 builder, $0.08 embeddings. All metered. |

**Ingestion, classification and every backfill run from a local terminal**, not from the
schedule — a 6,000-skill repository needs longer than any function ceiling, and locally there
is none. Start them in **your own shell**: a loop started from inside an agent session gets
killed with the session, which cost two runs before anyone noticed.

### Both backfills are finished, and one lesson from them is worth keeping

`EXTRACTOR_VERSION` went to **2.0.0** for blocks (A2) and `EMBEDDER_VERSION` landed with A6.
Every derived table is selected on its version string, so for a while both read as nearly
empty while the pages kept serving stored output — and the only visible symptom was a mining
run that quietly found no evidence. `archetypes --blocks` printing eleven rows of zeros at 1%
coverage was exactly that.

Both are now complete: **50,965 of 50,966** fingerprints, **1,620,316 blocks**, **47,854 of
47,855** embeddings. The single missing row in each is one skill version, not a stall.

> **What made them take longer than they should have: both commands processed 500 rows per
> invocation and stopped.** Finishing meant roughly a hundred manual runs, which is why "the
> scripts are done" was said twice while they were at 3% and 31%. `--drain` now loops both
> until the remaining count reaches zero. A backfill that needs a human in the loop per batch
> is a backfill that does not finish.

```
pnpm structures --extract 500 --drain    # free
pnpm embeddings --backfill 5000 --drain  # ~$0.08 for the whole corpus
```

> **`pnpm db:audit` answers "is the derived data current" in one command**, and it now
> answers it honestly. It used to print `total − current` as *re-derive outstanding*, which
> on an append-only table reports permanent history as permanent unfinished work: archetypes
> keep all 105 rows for R7.2 reproducibility and R3.5 drift-diffing, so that arrow could
> never be cleared by any amount of work. It now counts **subjects covered against subjects
> to cover** — versions, canonical skills, categories — with retained history printed under
> a heading that says it is retained. An alarm nobody can silence stops being read.

**The taxonomy gap is closed.** It was the dominant gap in every previous audit — 11,298
unlabelled at one point, widening with every sync. The corpus is now 97% labelled and held
sits at 0.35%.

> **What that cost, and why it is worth stating.** The classification itself was $12.41.
> Getting there took four vocabulary versions and a model change, and almost none of that
> effort went on classification — it went on measurements that looked right and were not. A
> keyword probe that counted `carbon-lang` as an energy skill. A log filter that could not
> match its own error string. Label *share* reported when labels-per-skill had moved
> underneath it. `verify:dedup` green throughout a total ingestion outage. The work was
> cheap; verifying it honestly was the expensive part, and that is the durable lesson from
> this stretch.

### Doc 2 is finished. Everything left is Doc 6.

Phases A and B are complete and step C3 with them. **No P0 that Doc 2 owns is open.**

| | | |
|---|---|---|
| A1–A6 | Foundations | blocks, activation cost, lifecycle, entitlements, pgvector |
| B1 | Outcome telemetry (R6.3) | `verify:outcomes` 28 checks |
| B2 | Public writes (R2.5, R1.8, takedowns) | `verify:flags` 24 checks |
| B3 | Similarity for authors (R3.6) | `verify:embeddings` 26 checks |
| B4 | Citable permalink (R8.4) + search re-measured | `verify:search` 11 checks |
| C3 | Block grammar, library, deviation marks | `verify:blocks` 55, `verify:archetypes` 20 |

The ordered plan for everything remaining is **Doc 2 §10, Phases C through G** — twenty-three
steps, re-derived on 2026-09-08 against the code rather than against the previous audit.
**Next is C1**, and C1 is the keystone: Interview mode, Distill, block editing, shared blocks,
MCP creation and improve-an-existing-skill all operate on a draft made of typed blocks, and
none of them can be built against a body string without being rewritten later.

**Four steps are unblocked right now** and were not when the plan was first written, because
A2, A4, A6 and B1 landed their dependencies: impact analytics is a surface over a query that
already exists (`outcomesForSkill` has zero call sites), freshness is a surface over a
mechanism that already runs, the demand board needs only query logging, and the knowledge
graph has all three of its inputs.

> **What the 2026-09-08 re-audit found, and it is worth knowing the shape.** The §10b table
> had drifted by two commits and was wrong in both directions. Four rows were **stale-done**
> (R4.3, R8.4, the `flagged` half of R6.3, the similarity half of R5.3). Three were
> **understated** — RK.2 and RK.6 are partial rather than absent, and RK.1's battle-tested
> branch is live rather than unreachable. Two stated blockers were **already dead**: R3.5 was
> waiting on embeddings that shipped in A6, RM.3 on an entitlement that shipped in A5.
>
> A status table read against a previous status table drifts silently. This one is now read
> against the code, and `pnpm db:audit` supplies the numbers rather than a human copying them.

### The Loop panel told an operator a dependency was outstanding while recording through it

`src/lib/outcomes.ts` · `pnpm verify:outcomes` (28 checks, free)

`UNIMPLEMENTED_KINDS` is the list of outcome kinds no code path can produce, so a dashboard
can say *not collected* rather than *none*. `flagged` stayed on it after B2 shipped the reader
route and `upholdFlag` began writing the row — so Settings → Loop reported **"Not collected
yet: flagged. Flagging needs a reader route (R2.5)"** on a platform that had one.

Two things were wrong and both are fixed. The list is corrected, and the *reasons* moved into
`UNIMPLEMENTED_REASON` beside it: the panel used to carry them as prose, so the list could
shrink in one file while its explanation lived in another. A reason now disappears exactly
when its kind does, and the paragraph vanishes entirely when the list empties.

> **The list cannot be derived, so it is checked instead.** "Implemented and nobody has done
> it yet" and "no code path can produce this" both show as zero rows, and only the first
> should read as *none so far* — so the list is a statement about the code and has to stay
> hand-written. `verify:outcomes` therefore asserts **every kind named on it has zero stored
> rows**. Write one and the suite goes red naming the kind to remove. Same discipline as
> `verify:lifecycle` compiling the lifecycle expression instead of holding a copy of it.

### A model id is a setting now, which the plan decided two days before it was true

`src/lib/models.ts` · `src/server/settings/models.ts` · Settings → **Models**
`pnpm verify:models` (20 checks, free)

The plan's 2026-09-06 entry said every model call should hold its id **as a setting rather
than a constant**. Half of it shipped — the classifier moved to Flash-Lite and the cost fell
accordingly — and the other half did not: four ids stayed hard-coded in four modules. That is
the fourth time this codebase has produced a decision recorded and then not applied, and it
mattered more than it looked, because every remaining step in the plan is a *new* model call
that would have arrived with its own constant.

No migration was needed. `platform_settings` is a generic key/jsonb table, so this is the
third instalment of "policy becomes data" in pure code, after the schedule and the rate
limits.

- **Resolved once per invocation**, then used by the model call, the budget check and the
  ledger alike. Reading the setting three times would let a save land between two of them and
  bill a call at a rate the budget was never checked against, and RC.2's whole design rests
  on the check and the ledger describing the same call.
- **An unpriced id is refused rather than stored.** `rateFor` falls back to the most
  expensive rate known, which is right for a budget and wrong as the silent consequence of a
  typo — and the person who made the typo is the only one who could have caught it
  immediately. The refusal names the id and the file to add a rate to.
- **Embeddings are deliberately not a task.** The vector width is fixed in the column type
  and in `EMBEDDER_VERSION`, so changing that model is a migration and a full re-embed. A
  control that cannot take effect is worse than no control.
- **Changing the classifier does not break R7.2**, because `skill_categories.model` records
  the gateway id per row. Labels from two models never wear one number even though they share
  a vocabulary version. That column is what makes this knob safe to turn.
- **The vocabulary lives in `src/lib/models.ts`**, a leaf module with no imports, because the
  admin panel is a client component and the settings module is `server-only`. Fifth time that
  split has been needed, after `dialects.ts`, `quality.ts`, `capabilities.ts` and
  `section-roles.ts` — it is a convention now rather than a discovery.

> **The verify script broke the platform once while being written, which is the best argument
> for the shape it ended up in.** The write probe saved its test value and then crashed on the
> *next* statement, an audit query naming a column that does not exist. The restore never ran
> and the classifier was left pointed at `claude-haiku-4.5` instead of `gemini-2.5-flash-lite`
> — **ten times the input rate, live, with nothing on any screen saying so.**
>
> That is exactly what `verify:schedule` documents about its own first version, which cleaned
> up with a delete that RLS refused silently and left the live scheduler holding clamp-test
> values. The restore is now in a `finally`, and the suite asserts the settings are left as
> they were found.
>
> Two smaller lessons from the same script. Its swap target was a hard-coded model id that the
> price table had never held, so the write probe **skipped** and reported green while three of
> its most important assertions had not run — the skip was hiding a broken fixture, not a
> passing path. And its actor was the string `"verify-script"`, which the `updated_by` foreign
> key correctly refused: a settings change has to be attributable to somebody who exists.


### What changed on 2026-09-01

A day of ingestion-reliability and agent-surface work. In rough order of consequence:

- **Two silent hangs, both R2.** A run would sit alive for hours holding one ESTABLISHED
  socket to `141.101.90.x` — the R2 endpoint — with no CPU and no GitHub quota consumed, and
  because the pass never ended it never wrote a completion event either, so it read as "stuck
  on pass two" rather than as a hang. **No outbound call had a deadline.** Every one now does,
  through `src/server/http/deadline.ts` and `r2Fetch`. See the section below: the first fix
  was aimed at the wrong subsystem because the grep that found the others could not see
  `aws4fetch`'s method-shaped `fetch`.
- **The derived stages were 42 of every 50-minute pass.** Validation, fingerprinting and
  signature building each read every bundle back from R2 **one at a time**. Now bounded-
  concurrent at 6: measured **801 ms → 182 ms per bundle**, a real pass from ~50 minutes to
  ~10.
- **Search stopped being `ilike '%q%'`** — `tsvector` + GIN, `pg_trgm` for typos, and R2.9's
  ranking as a *function*. `code review` used to return `AGENTS.md — Cross-Tool Agent
  Registry` first; `kubernets` returned nothing at all.
- **MCP shipped** (`/api/mcp`) — six tools, a free account and revocable token for quota
  identity, admin-tunable per-scope rate limits, and an untrusted-content fence on everything
  the corpus wrote.
- **Registry reconciliation** for skills.sh via its advertised sitemap: 2,422 repositories,
  **2,323 new to us**, filed as ordinary candidates and never auto-promoted.
- **Licence matcher learned Creative Commons and LGPL**, and a re-sync now refreshes a licence
  instead of discarding it — **187 skills became downloadable**, 33 correctly became
  metadata-only.
- **Three "recorded then ignored" bugs**, all the same shape: a curator approval that the
  re-apply sweep skipped, a re-submission that only re-enabled when it had config to merge,
  and a pause reason that named the wrong threshold.

### What is actually built


Ingest → validate → analyze → build works end to end. Every P0 in §7.1, §7.2, §7.3 and §7.7
is delivered or delivered-with-a-named-gap, plus all five cross-cutting P0s (auditability,
reproducibility, least-privilege, compliance, private-corpus isolation).

### §7.6 — the loop runs; the outcome half does not

R6.1, R6.2 and R6.5 are done: a skill authored here is published back through the same
pipeline, what happened while authoring it is recorded, and archetype regeneration reads that
alongside corpus prevalence. What is still missing is the **outcome** half:

- **R6.3 outcome telemetry** — no post-publication signal is attributed to an archetype
  version, so "what good looks like" stays a claim about the corpus rather than about
  results.

Everything else on the list is smaller than this.

### What to build next

**The ordered plan lives in `specs/plan.md`** — six milestones, twenty-three steps, with
sizes, dependencies and the critical path. `specs/core/02-requirements-spec.md` §10 carries
the same steps at requirement granularity and §10b the per-requirement status. Where the two
disagree, `specs/plan.md` is newer.

Both are **gitignored**, along with the rest of `specs/`. That is the deliberate consequence
of removing the specs from the remote repository: the roadmap is local to a working copy, so
this file is the only thing a fresh clone gets. If you are reading this without a
`specs/` directory, ask for the plan rather than reconstructing one.

Not duplicated here, because a roadmap in three places is a roadmap that disagrees with
itself twice.

**The Doc 6 workbench programme** (`specs/core/06-workbench-and-km-extensions.md`, RW.x/RK.x)
supersedes the builder and assistant gaps. Do not close R4.2, R5.1, R5.3 or R5.4 as
originally specified — Doc 6 argues the v1 builder is shallow at the *structure* level and
proposes a block model underneath it, and **that block model now exists** (A2). Building the
old spec would be work thrown away.

Phase A landed the foundations the rest of the programme is built against — blocks (A2),
activation cost (A3), lifecycle (A4), entitlements (A5), vectors (A6) — and Phase B closed
every Doc 2 loop gap. §10's Phases C through G are the whole remaining programme.

### Smaller named gaps, and where they now close

Each of these used to be its own line item. All of them are now a consequence of a plan step
rather than work to schedule separately, which is worth knowing before anyone opens one.

- **R2.8 collision risk** — the same measurement as RW.8's trigger-collision check, pointed
  at a new draft instead of a category. Closes with **D2**.
- **R4.2 live editor / R4.3 deviations** — R4.3 is **done** at block granularity. The editor
  is block editing, which is **C1b**.
- **R5.1 / R5.4 elicitation and per-suggestion feedback** — one motion in Interview mode,
  because every turn emits typed candidate blocks the author accepts or rejects. **C2b**.
- **R5.3 scope refinement** — the similarity half is **done** (B3); the demand-signal half is
  RK.5 and closes with **E3**.
- **R4.7 revisions / R5.6 improve an existing skill** — both are cheap over typed blocks and
  incoherent over a body string. **C1b** and **C6**.
- **R4.8 / R5.7 eval visibility** — both are "the builder can see eval results", which needs
  results. **D1**.
- **RC.4 billing webhooks** — not blocked: `setPlan` is the idempotent write a webhook would
  call and its upsert already tolerates late and duplicate delivery. **F2**.
- **RC.3 metering** — narrower than it reads. Every *model* call is metered and MCP makes
  none; what is missing is request-level accounting, and it needs a schema decision. **F1**.

### Deliberately deferred

- ~~**Embeddings / pgvector**~~ — **built** (A6, migration 0028). Was correctly parked until
  the corpus settled; vectors over a half-ingested corpus get rebuilt.
- **R2.10 sandbox** — needs execution infrastructure this project does not have. **R2.11's
  eval harness no longer waits on it**: the Eval Lab (plan step D1) runs prompts, not
  scripts, so it needs the entitlement A5 landed and nothing else.
- **Finishing the code-search crawl** — 38 shards saturated and unsplittable on the size
  axis. **The second axis turned out to be registry reconciliation, not a shard key:** four
  sitemap fetches against skills.sh produced 2,323 new repositories, quality-biased, from a
  channel that finishes. The crawl stays parked and is now unlikely to be worth resuming.

### Re-run these as the corpus grows — all free, all incremental

```
pnpm db:audit                  # did every migration land, and what is stale? free
pnpm taxonomy --sample 100     # only unlabelled skills; ~$0.29 per 100 — COSTS MONEY
pnpm taxonomy --sweep          # clears held rows nothing can decide; free
pnpm structures --extract 500  # fingerprints AND blocks; free — outstanding, see above
pnpm embeddings --backfill 5000 # vectors; ~$0.08 for the corpus — outstanding, see above
pnpm archetypes --mine-all     # free, append-only — NOT until the re-extract finishes
pnpm rescan --status           # verdict freshness after any analyzer bump
pnpm structures --templates    # structural diversity; the monoculture check
```

Comparing archetype **v5 against v6** after full ingestion answers the open question of how
much the sampled weak band was distorting the current numbers.

### Spend caps (RC.2) and metering (RC.3)

`src/lib/llm-pricing.ts` (rates), `src/server/billing/spend.ts` (caps), `llm_usage` ledger,
Settings → **Spend**. `pnpm verify:spend` (15 checks, **free** — a budget is arithmetic and a
refusal, and a test that burned real money to check a spend cap would be self-defeating).

**Two budgets, because RC.2 asks for two and they protect different things.** A per-org
monthly cap on builder and validation stops one customer running up a bill; a separate
global platform budget for corpus analysis stops our own batch work doing the same. Mixing
them would let either failure cause the other — a busy month of authoring must not halt
corpus analysis, and a taxonomy run must not spend a customer's allowance.

Defaults are `$5` per org and `$50` platform, from `LLM_ORG_MONTHLY_CAP_USD` and
`LLM_PLATFORM_MONTHLY_CAP_USD`.

- **Fail-closed means refusing, not degrading.** `assertWithinBudget` throws *before* the
  model call at all three call sites. No cheaper-model fallback, no soft warning that still
  spends. The error carries the cap, the spend and the reset date — RC.2 asks for clear UX,
  and a refusal a user cannot act on is the least clear failure there is.
- **The check is before, the ledger is after**, because cost is only knowable once tokens
  are counted. One call can therefore carry the total slightly past the cap; the next is
  refused. Reserving estimated tokens up front is a lot of machinery to avoid an overshoot
  bounded by one call, and it would refuse work whenever the estimate ran high.
- **Micro-dollars, integer.** A call often costs a fraction of a cent; floats accumulated
  over thousands of rows drift, and a budget that disagrees with the sum of its own ledger
  is worse than no budget.
- **Cache multipliers are priced.** Reads are 0.1× the input rate and writes 1.25×. Charging
  every input token at the base rate would overstate a cached workload roughly tenfold — and
  the taxonomy classifier is mostly cache reads. `usage.inputTokens` is the *total*, so
  billing it alongside the cache detail double-counts.
- **An unknown model over-charges.** `UNKNOWN_MODEL_RATE` is the most expensive rate we know
  of, because a budget that silently ignores a model it does not recognise is not a budget.
- **The ledger is append-only.** `llm_usage` has SELECT and INSERT policies and **no DELETE**
  — an application that can delete its own charges has no audit trail. Maintenance goes
  through `DATABASE_URL_UNPOOLED`, the owner connection migrations already use.

> **Three bugs the verification caught, all of which would have shipped silently.**
>
> **`recordUsage` wrote unscoped**, so every org-scoped row was refused by RLS — and because
> the function deliberately swallows its own failures, that refusal was a log line. Builder
> spend would never have been metered and the per-org cap could never have been reached:
> RC.2 satisfied on paper only. This is the exact failure the function's own comment warns
> about.
>
> **The first verify script spent the real $50 platform budget** and then could not clean up,
> because of the no-DELETE policy above — blocking corpus analysis until it was removed by
> hand. Fixtures must be cheap *and* removable.
>
> **Its second version set caps via `process.env` above static imports.** ESM hoists imports,
> so the assignment ran after `spend.ts` had read the environment and did nothing. The import
> must stay dynamic.

Also worth knowing: a per-workspace spend alert is an **org-scoped** `events` row, so an
unscoped operator query does not see it. The Settings panel shows the platform budget and the
per-purpose breakdown, both of which read the open `llm_usage` table.

### The schedule is data now, and archetype refresh is off

Settings → **Schedule**. `platform_settings` + `src/server/settings/schedule.ts`.
`pnpm verify:schedule` (9 checks, free).

The first instalment of the standing "policy becomes data" note. Sources per pass and the
per-source skill ceiling were constants inside the cron route; they kept their values and
moved into a settings table with their reasoning. Doc 3's argument — *cadence is data, not
deploys* — but the sharper version is that switching ingestion **off** through a redeploy is
worse than tuning it through one.

> **What "every N hours" actually is.** Vercel Cron fires on a fixed expression in
> `vercel.ts` (`0 5,17 * * *`) and nothing in a database changes that. The setting is a
> **minimum interval** the route checks when the cron fires: a tick that arrives early
> returns having done nothing. It throttles and switches off; it cannot accelerate. Asking
> for six hours against a twelve-hour cron gets twelve. The panel says so, because this is
> the easiest lie on that screen and the one an operator would discover weeks later.

**Archetype refresh ships OFF.** It is free — mining reads stored fingerprints and calls no
model — but it republishes the guidance every future draft is scaffolded from, and nothing
has watched it run at this corpus size. G2 wants it weekly; it gets switched on after a
deliberate `pnpm archetypes --mine-all` and a read of the changelog, not before.

Defaults live in `SCHEDULE_DEFAULTS` and an absent row means exactly them — the table is
empty on a fresh deployment, and a reader that guessed `enabled: true` would fetch
repositories before anyone had configured one. A partial row merges field by field, so a
value written before a knob existed cannot make that knob `undefined`.

> **`platform_settings` has no DELETE policy**, deliberately: a setting is changed, never
> removed, because deleting a row silently restores a default — the one transition an
> operator would not expect and could not see in the audit log. The first version of
> `verify:schedule` cleaned up with a delete, which RLS refused *silently*, and left the
> live scheduler holding the script's own clamp-test values (one hour, 25 sources, 10 skills
> a source). It now restores through the owner connection and **asserts the schedule is left
> exactly as it was found**.

Every change writes a `schedule.changed` event naming what moved. "Why did ingestion stop
three weeks ago" has exactly one good answer, and it is a row.

### Loop observability (R6.4), and the first real run

Settings → **Loop**. `src/server/analytics/loop.ts`. G3 (first-pass validation, target 80%),
G4 (sessions using a corpus suggestion, target 60%), each archetype's current version with
the changelog that explains it, and **unconsumed signal per category**.

**The stall alert is the part that earns its place.** A dashboard of green numbers is easy to
build and easy to stop reading; the question nobody thinks to ask is *signal is arriving and
nothing is learning from it*. Mining is a manual command, so a category can accumulate
authoring feedback for weeks while its guidance sits where it was. Nothing errors. Twenty
unconsumed signals raises it and names the free command that fixes it.

Shares carry their sample size, and below ten sessions they are marked thin — a percentage
over three drafts is one draft's opinion to two significant figures, and G3/G4 are targets
someone will eventually report against.

> **Two bugs the live data exposed, both the same shape.** The panel first reported *0 drafts
> written, 1 published* — nonsense that was actually the isolation working: `skill_drafts`
> holds the author's purpose and notes, so an operator cannot read it and should not. There
> is now deliberately **no "drafts written" figure**; every number comes from
> `builder_signals`, which is readable across organisations precisely because it carries
> nothing private.
>
> The activity feed silently omitted `builder.published`, because that event is org-scoped
> and the feed reads unscoped. It now lists platform-scoped kinds only and says so — a feed
> that quietly drops the most interesting event in the loop while looking complete is worse
> than a shorter one.

### The loop has actually run

`pnpm walk:loop` — **costs money**, one generation. Not a test: it takes a real skill the
whole way and leaves it behind, because the point is to have the loop run rather than to
assert that it could.

First run, 2026-08-31:

```
Terraform plan review → /skills/terraform-plan-review
  scaffold   review archetype v5 · 258 structures from 45 sources
  generate   7,712 chars · quality 100/100 · 0 findings · sonnet-5
  publish    indexed · structural-lint@1.4.0, secret-scan, prompt-injection,
             capability-surface — all pass
  lineage    archetype review v5 · authoredHere: true
  telemetry  5 signals, all survived, firstPass=true
  spend      $0.05, metered against the workspace cap
```

All five archetype-offered sections survived into the published document, which is the first
real evidence that the `review` skeleton is worth following rather than merely mined.

### Creation telemetry (R6.2) and its bounds (R6.5)

`src/server/builder/telemetry.ts`. `pnpm verify:telemetry | verify:spend | verify:schedule` (8 checks) and three more in
`verify:publish`. Both free.

One row per `(draft, section role)` at publish: was the section **offered**, did the author
**author** notes for it, did it **survive** into the published body, and did that document
pass validation **first time** (G3). `mineArchetype` then decides inclusion on
`lift + delta` — so a section the corpus is lukewarm about but that authors consistently
keep can cross the threshold, and one the corpus likes but authors delete can fall below it.
That is the loop closing.

**Lift and telemetry are kept separable, never averaged.** They answer different questions —
what other people published versus what happened when someone used this skeleton — and a
single blended number answers neither. The archetype page shows both and says which is
which.

**Structure only, never content.** Every column is a boolean or a value from a closed
vocabulary we defined: a function category and a section role. No skill text, no names, no
author input. That is what makes R6.2 compatible with **RC.5 and OQ-C2**, which forbid
org-private corpora feeding public archetypes even in aggregate — "the `troubleshooting`
heading survived" is a fact about our own vocabulary, not about a customer's workflow.

> **`builder_signals` has the only split RLS policy in the schema**: writes are org-scoped,
> reads are open to `app_runtime`. Cross-organisation aggregation is the entire point of
> R6.2, and a read policy on `app.org_id` would let an archetype learn from one tenant at a
> time — useless, and the shape RC.5 forbids. It is safe *because of the column list*, and
> the migration says so: add a column carrying tenant content and this policy becomes wrong.

**R6.5 is four defences, not a flag**, and each stops a different attack — implementing one
and calling it done leaves the rest open:

| defence | mechanism | attack it stops |
|---|---|---|
| dedup per identity | unique index on `(draft_id, section_role)` | republishing to vote twice |
| rate limit | `MAX_DRAFTS_PER_ORG` applied **in SQL before counting** | one org making many drafts |
| outlier trimming | drop the extreme **organisations**, not drafts | a coordinated tail dragging the mean |
| bounded delta | ±`MAX_LIFT_DELTA` (5 points) per mine | everything that beat the first three |

Trimming is per organisation rather than per draft because the unit of manipulation is an
account: trim drafts and one org can supply both tails and keep its own middle. The rate
limit runs before aggregation for the same reason — an org contributing 200 votes and *then*
being trimmed as one outlier has already moved the mean.

`MIN_DISTINCT_ORGS` sits under all four. Below it nothing is applied, which serves R6.5 **and**
privacy: an aggregate over one or two organisations could describe a single tenant. One
mechanism, two requirements, and relaxing it for either would break the other.

**The changelog cites the statistics**, because R6.2's acceptance criterion says it must.
Telemetry that silently influenced published guidance would be exactly what R7.1's
auditability exists to prevent — and exactly the shape a poisoning attack would want.

### Publish-back (R6.1) and export (R4.4)

`publishDraft` writes the same rows `syncSource` writes and hands the version id to
**`validatePending`** — the same function the pipeline runs over externally synced skills.
R6.1 says a skill created here enters the same pipeline with no privileged path, and the
only honest way to satisfy that is to call the same code rather than reimplement a lighter
version and trust it stays equivalent. `pnpm verify:publish` (15 checks, free) asserts on
*verdict rows existing*, not on the status field — a status can be set by anything; verdicts
can only exist if the real validator ran.

- **Org-scoped, not public.** Publishing means "a real, validated, downloadable skill in
  your workspace". Promoting to the public corpus is a licence-and-review decision nobody
  has made.
- **The source is real**, because `skill_versions.source_id` is NOT NULL and the schema is
  right to insist. Each org gets one `builder` source: `enabled = false` so the scheduler
  never offers it, org-scoped so public statistics never count it. Both fall out of existing
  behaviour rather than needing special cases.
- **`licenseSource: "authored"`** is a new enum value, distinct from `unresolved`. "We looked
  and could not tell" forces a metadata-only posture and would make the platform refuse to
  store the thing it just helped write.
- **Lineage** — archetype category and version on the version's provenance, and
  `publishedSkillId` on the draft, so "what was this authored from" and "what did this
  become" are each one hop.

> **Two bugs the verification script found, both of which would have shipped.**
>
> `validatePending` selected with a plain `db` handle and **no org scope**, so RLS answered
> `org_id IS NULL` only — an org-scoped version was **invisible to the validator**. Publish
> would have created a skill, called the validator, and silently validated nothing, leaving
> it at `pending` for ever. The write path was already correct (`validateOne` sets
> `app.org_id` from the row); only the read was missing, which is the failure mode that
> hides best. `ValidateOptions.orgId` fixes it.
>
> The `events` audit row was inserted after the transaction with a plain `db` handle and was
> refused by RLS outright. It now goes inside the transaction, which is also where it
> belongs — a skill existing with no record of who published it is the gap R7.1 exists to
> close.

**Export** renders one draft into one archive, a directory per format, because SKILL.md and
AGENTS.md both sit at a project root and a flat archive would silently overwrite. Formats
differ only in the envelope: AGENTS.md has no frontmatter *by specification*, a Cursor rule
uses Cursor's keys (`description`, `globs`, `alwaysApply`). No model pass to "adapt tone" —
that would be an uninstructed edit of the author's words and would make two exports differ.

Descriptions are JSON-quoted on the way out. Ten corpus skills were quarantined because an
unquoted colon made YAML read a nested mapping, and a builder that emitted them raw would
manufacture the defect its own validator flags. `verify:publish` uses a description with a
colon in it for exactly this reason.

> `EXPORT_DIALECTS` lives in `src/lib/dialects.ts`, not beside the renderer. The checkbox
> list is a client component and the renderer is `server-only`; the build refused the import,
> correctly. Same split as `capabilities.ts`, `quality.ts` and `section-roles.ts`.

### The heartbeat, and the class of bug behind three lost runs

`src/server/pipeline/heartbeat.ts` · migration 0020 · `pnpm pipeline --status` · Settings → Ingestion

Three separate stalls were diagnosed by hand with `ps` and `lsof`, and each time the hardest
part was not the fix — it was establishing **whether anything was wrong at all**. A pass
writes its `events` row when it *finishes*, so a pass that hangs writes nothing, and
"ingesting a 6,000-skill repository" and "stalled on a dead socket" produce identical
evidence from outside: no new events, a live process, no new rows for a while.

A completion record cannot answer "is it stuck" by construction. Only a progress record can.
So one row is updated **during** a stage — stage, a human sentence, done/total, pid — and the
number that matters is how old it is. `--status` prints it; the Ingestion tab shows a pulsing
dot, or a red one past two minutes.

Throttled to one write every 15 seconds, so calling it per skill costs nothing at 2.6 skills
a second, and it **never throws**: bookkeeping that could kill a six-hour run to report on it
would be worse than no bookkeeping.

> **The deeper lesson is about the fixes, not the bugs.** Every stall was one of two things —
> an unbounded wait, or an unhandled error inside a bulk loop — and each first fix was
> *verified weakly*:
>
> - "no bare `fetch(` remains in `src/server`" was proven with a grep that structurally
>   **could not see** `aws4fetch`'s method-shaped `r2Client().fetch(...)`. It returned clean
>   and meant nothing; the four R2 calls stayed unguarded and hung the next run.
> - the unique-violation guard read `error.code` on Drizzle's wrapper, where the driver code
>   lives on `.cause`. It matched **nothing**, and shipped without once being run against a
>   real `23505`.
>
> Both would have failed in ten seconds against the actual error. **A check that cannot
> observe the failure it is about is not evidence.** `verify:http-deadline` and
> `verify:db-retry` are written the other way round on purpose: reproduce the failure first,
> then assert the fix, so the fixture is proven to still reproduce the bug.

**Isolation is now a property of the primitive, not a thing a call site remembers.**
`mapSettled` records per-item failures and never rejects. That is the durable half of the
lesson: `syncSource` wrapped its fetch but not its write, so one refused insert cost an entire
6,864-skill repository, and `validatePending` wrapped nothing, so one unreadable bundle would
have discarded 500 computed verdicts. Both were latent while the loops were sequential and
fired the moment they were not.

### MCP (RM.1, RM.2) — the agent surface

`src/app/api/mcp/route.ts` · `src/server/mcp/` · `pnpm verify:rate-limit`

Six tools — `search_skills`, `get_skill`, `download_skill`, `list_archetypes`,
`get_archetype`, `corpus_stats` — each a **thin wrapper over the same `src/server/**`
function the web pages call**. That is the requirement, not laziness: RM.2 says an answer must
not differ between web and MCP, and the only honest way to guarantee it is to call the same
code. Reimplementing a lighter read would mean two definitions of "servable", and the second
would drift on licence gating and takedowns, where drift is a legal problem rather than a bug.

`download_skill` is the clearest case: it calls `exportSkill` and discards the bytes, so it
inherits all three refusals — withdrawn, unlicensed, metadata-only — for free.

**A route handler is the documented exception**, same as the download route: MCP is a wire
protocol, and a server component renders HTML while an action returns a value to our own
client bundle. The file touches no `@/server/db`, `drizzle-orm` or `pg`.

**Structured input, because the caller is a machine.** The registry's UI has one search box
because screen space is finite and people self-correct; an agent fills a schema perfectly and
then acts on the top hit. So the search tool exposes both category axes, capability, licence
posture and a quality floor, and every enum is the real vocabulary — an agent guessing
`"reviewing"` gets a schema error naming the 13 valid options, not zero results it would read
as "the corpus has none".

#### The untrusted-content fence is the part with no equivalent elsewhere

`src/server/mcp/untrusted.ts`. Every analyzer here treats corpus text as untrusted input,
because a skill is a document written by a stranger to steer an agent. MCP hands that same
text to **somebody else's** agent, over a channel whose entire content is instructions the
caller is inclined to act on. A tool returning a skill body as bare prose turns this registry
into an injection vector pointed at its own users.

So corpus text leaves inside `<untrusted-corpus-content>` carrying slug, source, status and
quality — **and a random 96-bit nonce on the close tag**, because the marker is public and a
skill that simply writes our closing tag into its own description would otherwise break out of
the fence it was put in. This does not make the text safe; nothing can. It makes it labelled,
which is the most an interface can honestly offer.

#### A free account, and why that is not a paywall

The web pages, downloads and every trust surface stay anonymous — R8.1 is untouched, and
everything these tools return is readable in a browser. What the endpoint requires is a
**token**, because the limiter needs an identity and an anonymous protocol offers only an IP:
shared behind a NAT, rotated at will, a bound on accidents rather than abuse.

`mcp_tokens` is ours rather than Better Auth's, because **better-auth 1.7.2 ships no api-key
plugin** and that pin is load-bearing. It is also the better answer: an MCP token must not be
a session. A leaked session is an account; a leaked token here reads the public corpus through
a rate-limited endpoint and is revoked without signing anyone out. Only `sha256(token)` and an
8-character prefix are stored, so the value is shown exactly once.

> **§7.7 RM.1 says "better-auth api-key plugin". That sentence is wrong, not the code.**

`mcp_tokens` carries the schema's **second split RLS policy**: SELECT is open because
authenticating a request means looking a token up *before* any organisation is known — that
lookup is how the org is discovered — while INSERT and UPDATE are org-scoped. It is safe
because of the column list: hashes and prefixes, never a usable credential. Add a column
carrying a secret and the policy becomes wrong.

#### Rate limits are settings, not constants

`src/server/settings/rate-limits.ts`, Settings → **Rate limits**. Two windows because they
stop different things: per-minute catches a tight loop, per-hour catches a patient one pacing
itself just under the minute limit. Counters live in Postgres — one row per identity per
bucket carrying its own `windowStart`, so the table does not grow a row per minute. That makes
it a **fixed window**, which permits up to 2× across a boundary; the right trade for stopping
a runaway agent, and stated rather than discovered from a graph.

**It fails open**, deliberately inverting this codebase's usual posture. A spend cap that
fails open costs money, so it refuses; a rate limit that fails closed takes the public
registry dark because a counter table blinked. The data behind it is public and read-only.

A refusal names its window, its limit and when it lifts, as HTTP 429 **and** a JSON-RPC error
— the status is what a transport retry policy reads, the message is what the model reads. An
agent that cannot tell a throttle from a permission failure retries a hard failure for ever or
abandons a soft one, and both look like our bug from outside.

### Every outbound call has a deadline, and finding that out cost two runs

`src/server/http/deadline.ts` · `r2Fetch` in `storage/client.ts` · `pnpm verify:http-deadline`

Two ingestion runs hung. Each time the process stayed alive for hours holding **one
ESTABLISHED HTTPS socket**, burning no CPU and consuming no GitHub quota — and because the
pass never finished it never wrote a `pipeline.completed` event either, so from the outside
it looked like a run stuck on pass two rather than a hang. **A run that dies is visible; a run
that waits is not.**

Node's undici defaults do not cover this. `headersTimeout` and `bodyTimeout` fire when
*nothing* arrives; a half-open connection — the peer's return path dropped by a NAT, or a CDN
edge that went away mid-exchange — leaves the socket ESTABLISHED locally and the read pending
for ever. `AbortSignal.timeout` covers the whole exchange, which is the property that matters:
the stall can happen at connect, at headers, or partway through a body.

> **The first fix was aimed at the wrong subsystem, and the verification is what failed.**
> The stalled peer was `141.101.90.96`, which was assumed to be GitHub. It is **R2** — that
> bucket's endpoint resolves to exactly `141.101.90.96–99`. Worse, the check used to confirm
> the fix was `grep "await fetch("`, which returned clean and proved nothing: `aws4fetch`
> exposes fetch as a **method**, `r2Client().fetch(url, init)`, so the four R2 calls were
> invisible to the search that found the other ten. A grep that cannot see a call site is not
> evidence that the call site is guarded.

Two deadlines, and the second is not padding. `REQUEST_TIMEOUT_MS` is 30s; recursive
git-trees get `LARGE_RESPONSE_TIMEOUT_MS` at 120s, because a whole-repository tree approaches
the API's ~100k-entry ceiling and GitHub builds it on demand — and **a false timeout on an
enumeration is not a retry, it is a tombstone**, since R1.5 reads an incomplete enumeration as
deletion.

`verify:http-deadline` reproduces the bug before asserting the fix, like `verify:db-retry`: a
local server that accepts the connection and never answers. It also pins a *dependency's*
behaviour — that an `AbortSignal` survives `AwsClient.sign()` building a fresh `Request` — so
an upgrade that breaks the propagation turns a check red instead of turning the pipeline back
into a process that waits for ever.

### The derived stages read every bundle one at a time

`src/server/lib/concurrency.ts` · `ingestPolicy.bundleConcurrency`

A 50-minute pipeline pass spent **~8 minutes syncing and ~42 in the derived stages**.
Validation, structure extraction and signature building each pulled every bundle back from
object storage sequentially — and each pulled the *same* bundles independently, so one pass
made roughly 1,500 sequential round trips to an EU bucket before doing any work.

The connector had solved this years earlier for the write side, with the comment still
attached: sequential fetching "made a 12-file skill take a dozen round-trips end to end, and a
large one minutes." The lesson had simply never been applied to the read side.
`mapWithConcurrency` now lives in a leaf module and serves all four call sites.

Measured against the real bucket, same 40 bundles: **801 ms → 182 ms per bundle**, and a real
pass from ~50 minutes to ~10.

**Six, because the database pool is capped at ten** and each lane holds a connection while it
writes its result. Four in reserve keeps the queries that decide what to do next from queueing
behind the batch. It uses a shared cursor rather than pre-sliced chunks — with bundles of
wildly different sizes, chunking leaves most lanes idle waiting on the slowest item in their
own chunk.

Safety was checked per stage rather than assumed. Fingerprints and signatures write one row
each, keyed per version, with nothing shared. Validation's only shared write is
`skills.currentVersionId`, which two *pending versions of the same skill* could contend for —
measured at **zero**, and structurally impossible, since a second version is only created once
the first has been judged. Counters mutated from several lanes are safe on a single-threaded
event loop: every increment happens between awaits, never across one. Each stage catches
**inside** the worker, so one unreadable bundle still cannot cost the batch.

### Search: a tsvector, a trigram index, and a ranking function

Migration `0017`. Search was `ilike '%q%'` over name, summary and slug — a leading `%` means
no btree can serve it, there was no textual index on `skills` at all, and a LIKE match carries
no notion of *where* it matched, so results fell through to the quality sort.

The failure was not subtle. `code review` returned **`AGENTS.md — Cross-Tool Agent Registry`**
first; `terraform` returned `cloud-architect` and `cloudflare`; `kubernets` returned **nothing
at all**.

- **Relevance** — a generated `search_vector`, weighted `A` name, `B` summary, `C` slug, with
  a GIN index. Generated and stored, so it cannot drift: no trigger to forget, no backfill
  after an edit. `'english'::regconfig` is passed explicitly and must stay — the one-argument
  `to_tsvector` reads a GUC and is only STABLE, and a generated column requires IMMUTABLE.
- **Typos and partial words** — `pg_trgm` on the name. The two indexes fail in opposite
  directions, so the query ORs them and Postgres BitmapOrs both.
- **Ranking as a function** (R2.9), not a tiebreaker list: `ts_rank_cd` normalised with flag
  32 into 0–1, `greatest`-ed with trigram similarity so a skill *named* the query wins
  outright, plus quality at a quarter weight. Popularity has no vote at all, which is the
  simplest way to guarantee R2.9's rule that it must never outrank quality.

The **security-tier term is the filter**, and that is the honest reading: only `indexed`
skills are ranked at all, and weighting a column that holds one value for every row would be
decoration until R2.14's verified tier exists.

Categories were never the problem — `skills.categories` already had a GIN index. What was
missing for a machine caller is *structured input*, so `listSkills` now takes `categories[]`
(both axes ANDed) and `minQuality`.

### Registry reconciliation: a sitemap, not an API

`src/server/crawl/registries.ts` · `pnpm registry --status | --import`

Doc 4 §4 channel 4 (R1.1(d)), never built. skills.sh's `robots.txt` **disallows `/api/` and
`/search`** and advertises `/sitemap.xml` — so the sitemap is the interface its operators
intend automated readers to use, and it is the only one this touches.

It also turned out to be the cheapest: the URL shape is `/{owner}/{repo}/{skill}`, so **the
repository is in the path**. Four XML fetches answered what 20,000 page fetches would have.
Result: 2,422 repositories, **2,323 new to us**, ~16,800 skills behind them — including
nvidia, google, github, adobe, grafana, openai and forcedotcom, none of which the size-sharded
crawl could ever have prioritised.

> A first pass misread the shape as `/{owner}/skills/{skill}` and reported "317 owners". The
> tell was arithmetic that could not be true: 317 owners covering 17% of 20,000 URLs when
> sorted *descending*. A ranking where the top-N covers less than the tail is not a finding,
> it is a parse error.

Three rules it holds to: the pointer only, never content; `hitCount` stays 0 because "a list
named this" is different evidence from "the crawl saw N markers"; and nothing is
auto-promoted — the upsert refreshes `lastSeenAt` and touches neither status nor skipReason,
so a repository a curator already rejected is not resurrected because a registry still lists
it. Verified: of the 99 already known, 97 stayed `promoted` and 2 stayed `skipped`.

### One repository, two rows — GitHub folds case and our indexes did not

`src/server/crawl/repo-identity.ts` · migration 0021 · `pnpm verify:dedup` (15 checks, free)

GitHub resolves `owner/repo` **case-insensitively**. Every identity comparison in the
ingest path was an exact string `=`, and both unique indexes were case-sensitive —
`sources_public_url_uq` on the raw `url`, `discovered_repos_uq` on the raw `(owner, repo)`.

So when code search reported `NVIDIA/skills` on one crawl day and `nvidia/skills` on
another, the second was a *new* candidate, `promote()` looked for `url =` and found
nothing, and the repository got a second source row. **15 repositories reached that state**
— `NVIDIA/skills` holding 268 indexed skills and `nvidia/skills` another 99. One repository
fetched twice, its skills split across two rows, its GitHub quota spent twice, and both
rows counted separately in every per-source statistic.

Nothing errored. Two rows was exactly what the schema permitted.

> **It surfaced sideways, which is the part worth remembering.** Nobody was looking for it.
> It fell out of a `group by lower(name)` run while checking whether the archetype band's
> `CURATED_SOURCES` lookup — a `Set` of `owner/repo` strings — could miss a curated source.
> It could: `NVIDIA/skills` matched the seed list and `nvidia/skills` did not, so a third of
> that repository was banded untrusted. A case-sensitive `Set.has` on data GitHub considers
> case-insensitive is the same bug as the index, one layer up.

**Folded in the index, not normalised in the row.** `name` and `url` keep whatever casing
GitHub reported, because that is what a reader and an attribution list should see —
`NVIDIA/skills`, not `nvidia/skills`. Only the comparison folds. Rewriting the column would
make the display wrong to fix the lookup, and would still leave the next call site free to
compare exactly.

Both halves are needed and they do different jobs: `sameRepoUrl` / `sameRepoSegment` keep
the code from creating a duplicate, and the folded indexes make it impossible for a call
site that forgets them. Applied at every identity resolution — `promote`, `submit`,
`seed-run`, `upsertSource`, the curation queue — **and in `compliance/takedown.ts`, which
was the one with teeth**: a takedown matches `sources.url = takedowns.source_url`, and
notices are hand-entered by a curator from an email, so a casing difference meant a block
that silently did not enforce.

**`kind` is in the key on purpose.** `ComposioHQ/awesome-claude-skills` is on the seed
*list* allow-list, read for the repo links inside it, and the crawl separately promoted it
as a content repo shipping six skills of its own. Two connectors, two legitimate reads of
one URL. Folding without `kind` would have forced one to be deleted. It does not reopen the
bug — every duplicate group was a single `kind`, which is why the merge covers 14 groups
and not 15.

**25 skills were deleted, and only those 25.** Three repositories had the same upstream
*path* under both casings. After repointing they would be two `skills` rows sharing one
`(source_id, path)` — and the write path resolves that key with `limit(1)` and **no
`ORDER BY`**, so the next sync would update an arbitrary one and leave the other
permanently stale: never refreshed, and never tombstoned either, because its path is still
in the enumeration. The staler *fetch* lost, not the losing source's copy; in all 25 cases
the fresher content had come through the lowercase row, and three scored better for it
(`vss-manage-alerts` 19 → 59).

> Deleted rather than linked under `canonical_skill_id`, which was the tempting answer.
> That column is owned by `analytics/dedupe.ts`, whose `--reset` clears **every** value in
> the table — so a variant link written by a migration would be undone by an unrelated
> dedup re-run, restoring the ambiguity with nobody watching. These rows are an artefact of
> our own bug, not upstream content, and the bytes are re-fetchable.

Merge rules, each protecting something: winner is **most versions, then oldest, then id**
(most versions keeps the larger half; oldest carries GitHub's own casing; id makes a re-run
deterministic). `config` merges as `loser || winner`, so an `allowLargeRepo`, `approvedBy`
or `includePaths` on the row being deleted is not discarded — the same "decision recorded
then ignored" failure as the three below. `hit_count` takes the **max, not the sum**:
it records what code search saw in one sighting, and adding two sightings together would
invent evidence.

Result: sources **909 → 895**, candidates **3,317 → 3,277**, skills −25. The confirmation
is arithmetic nobody had to trust: merged, `NVIDIA/skills` holds **346 indexed skills
against the 348 markers GitHub reports** — the split had been hiding 78 of them.

> **The migration was dry-run against the real database inside a rolled-back transaction
> before it was applied, and that is what caught the bug in it.** `array_agg` over a
> `text[]` column returns a 2-D array whose subscript is an *element*, not a row, so the
> `sample_paths` merge failed with `COALESCE types text[] and text cannot be matched`. A
> migration reviewed only by reading is a migration whose first execution is in production.

`verify:dedup` **attempts the insert that caused the bug** and requires a `23505`, rather
than asserting the data is currently clean — clean data proves nothing about whether it can
get dirty again. Same shape as `verify:http-deadline` and `verify:db-retry`.

> Its `(source, path)` check must be scoped to public `github_repo` sources, and the scope
> is a finding rather than a convenience: each organisation's `builder` source deliberately
> holds every published draft at `SKILL.md`. It is never enumerated — `enabled = false`, no
> upstream — so the write path never resolves that key against it. The unscoped version read
> the builder as a defect, which is how it first came back red.

**Still open:** archetype v6 was mined before this merge, so its R3.4 attribution lists
`NVIDIA/skills` and `nvidia/skills` as two contributors. `mineAndStore` skips on an
unchanged skeleton and matching miner version, and `--force` only bypasses the evidence
gate, so there is no way to re-store without a real change. The next mine after labelling
corrects it.

### Three bugs with one shape: a decision recorded, then ignored

All three surfaced in an afternoon, all three let an operator make a choice the system then
failed to apply.

- **`reapplyMarkerThreshold` skipped approved sources.** The guard meant "do not overrule a
  curator" — right about re-pausing, exactly backwards here, because the curator's decision
  *was* "sync this". Two sources sat disabled-and-approved with nothing able to release them.
- **`submit` only re-enabled when it had config to merge.** Gated on
  `includePaths?.length || reviewedLargeRepo`, so re-submitting a paused source that needed
  neither did nothing — while the block's own comment promised "must come back enabled, or the
  admin's decision is recorded and then ignored."
- **The pause reason named the wrong threshold.** Two different gates called one
  `holdForReview`, which stamped the marker threshold into the sentence whichever had fired —
  filing a 384-skill repository stopped by a 120-skill *pass ceiling* as "over the 500
  threshold". `healthDetail` now carries a typed `heldBy`, and the sweep releases a
  `pass-ceiling` hold unconditionally because nobody decided anything about the repository.

Widening that sweep's query nearly caused a fourth: dropping the `health = 'paused'` filter
pulled in each organisation's `builder` source, which is `enabled = false` **by design** and
has no upstream to fetch. `org_id is null` now scopes it to public discovery sources.

### A re-sync used to discard a licence it had just resolved

`writeSkillVersion`'s content-hash dedup returned `"unchanged"` before any licence write, so
identical bytes threw away a freshly resolved licence. It only mattered once the chain got
better — adding Creative Commons and LGPL body patterns re-classified a 166-skill repository
from `unresolved` to `attribution_required`, `storeBundle` dutifully uploaded the bytes, and
the row kept saying unresolved. **A resolver improvement that cannot reach already-synced rows
is a resolver improvement nobody sees.**

Fixed in `syncSource` rather than as a separate sweep, so every future re-sync is
self-healing. Three guards, each stopping a real failure: same `(source, path)` only, because
the dedup lookup matches on hash across *all* sources and the row found may belong to a
different repository shipping identical bytes; `indexed`/`quarantined` only, because restoring
a licence on withdrawn content would undo a takedown on a schedule; and only when something
actually moved, so it is not a write per skill per sync.

Result: **187 skills unresolved → downloadable**, 33 → `metadata_only` (Elastic 2.0 — an
explainable refusal rather than "we could not read your file"). `relicensed` is its own count
in the CLI and pipeline summary: the corpus did not grow, but unservable skills became
downloadable, and that reads differently to an operator.

> **Measured before building.** The plan had been to implement R1.6 steps 4–5 (ClearlyDefined,
> ScanCode) to recover "up to ~1,000" skills. All 1,968 unresolved skills come from 92
> repositories; checked against GitHub, **85 of them holding 1,713 skills have no licence at
> all**. An unlicensed repository is all rights reserved and no scanner can invent a grant.
> The estimate was wrong by 5×, and the fix was in step 2 all along.

### The registry read the whole table to draw its sidebar

`/skills` took **2.3 seconds** against 0.2 for `/archetypes`, and clicking it from the
sidebar looked like nothing had happened. Two separate faults, fixed separately.

**The query.** `getFilterOptions` selected *every indexed skill* — one row per skill, no
limit, ~6,100 of them — pulled them all into node and tallied them with `Map`s. It then took
the version ids from those same rows and asked for capability surfaces with a
**6,100-element `IN (...)`**. Paging the list to ten results was pointless while rendering
the filters beside it read the entire corpus, and the cost grew with the corpus rather than
with the page: at R7.4's 500K target it would not have loaded at all.

Every count is now a `GROUP BY` or a `count(*) filter`. The category facet already worked
this way — it was the one part of the function that was right, and it is the model the rest
now follows. **2.3s → 0.5s**, and the totals were checked against direct SQL rather than
assumed: 9,561 indexed / 6,768 mirrored, identical before and after.

> The capability counts are five `count(*) filter` expressions over the same jsonb key
> lookup that `whereFor` uses to apply the filter. Same expression on both sides is what
> keeps the sidebar's number and the filtered result in agreement.

**The perceived stall.** Next renders a server component *before* it navigates, so a slow
page leaves the previous one on screen and the click appears to do nothing. `loading.tsx`
turns the segment into a Suspense boundary: navigation becomes instant and the wait moves
somewhere visible. Added to `/skills`, the skill page, both archetype routes, and the
dashboard, settings and builder.

`PageSkeleton` is shaped like the page it replaces — heading, controls, list rows — so
content does not jump when it arrives, and it carries `role="status"` so a screen reader is
told the page is loading rather than finding it briefly empty.

> A loader is a fix for the *perception*, never for the page. The query was fixed first; the
> skeleton is there because half a second of blank screen still reads as a stall.

### `truncate` on a flex child needs `min-w-0`, or it widens the whole card

Settings → Ingestion overflowed its card when the sidebar was open: the green run button was
pushed past the card's right border and clipped, and the run-history lines were cut mid-word
(`… 3 deferred, tin`). It looked like a clipping bug and was the opposite — the card's
*content* was genuinely wider than the card, and the browser painted it outside the border.

**One line caused it.** `truncate` is `overflow:hidden` + `text-overflow:ellipsis` +
**`white-space:nowrap`**, and a flex or grid child defaults to `min-width:auto` — meaning it
refuses to shrink below its own min-content width. A `nowrap` child therefore has a
min-content width equal to the entire unbroken string, which propagates up through every
ancestor and widens the card. The element that was supposed to truncate is the element that
makes truncation impossible.

`min-w-0` on the truncating child is the whole fix, and it was missing at eight sites:
`settings/pipeline-panel` (2), `settings/taxonomy-panel` (2), `settings/takedown-panel`,
`settings/submit-panel`, `settings/review-panel`, `registry/capability-surface`,
`archetypes/attribution-card`. Grid children have the same default, so a `truncate` inside a
`grid` container needs it too — this is not a flexbox-only rule.

> Tailwind's `grid-cols-*` already emits `minmax(0, 1fr)`, so the **track** can shrink. That
> is what made this confusing to read: the card's border box stayed at the column width while
> its contents did not, which looks like clipping rather than overflow. Do not go looking for
> a missing `overflow-hidden`; look for the child that cannot shrink.

The pipeline panel is now **full width with the cards stacked** rather than
`lg:grid-cols-2`. The run-history lines read as prose and half a row was never enough for
them at any sidebar state. The `min-w-0` fixes stay regardless — the layout change alone
would only hide the bug at wide widths, and it would come back on a phone, a collapsed
sidebar, or the next two-column card someone adds.

### The builder (R4.1–R4.5, R5.5)

`/build`, protected. Four steps — category, purpose, your context, sections — then one model
call. `pnpm verify:builder` (11 checks, **costs money**: two real generations).

**The shape is not ours.** Step four is the mined archetype for the category chosen in step
one: its sections, in document order, each showing prevalence in both bands. A wizard that
asked "which sections would you like?" would be a blank page with a progress bar, and R4.1
is specifically about the corpus already knowing the answer.

- **Drafts are their own table, not rows in `skills`.** `skill_versions.source_id` is NOT
  NULL and points at a repository we sync, so reusing the corpus tables means inventing a
  fake source per organisation — which `platformStats` would then count, `pendingSources`
  would offer, and source-diversity reporting would fold in. The public corpus numbers would
  move every time somebody opened the builder. A draft becomes a skill when it is published,
  and that is when the corpus tables should hear about it.
- **`org_id` is NOT NULL here**, unlike everywhere else, and the RLS policy correspondingly
  has no `IS NULL` escape hatch. There is no such thing as a public draft, so a request with
  no session sees nothing rather than seeing "the public ones".
- **The inputs are committed before the model is called.** A generation that fails or
  refuses costs the draft, never the author's typing. `generating` is a persisted state, not
  a spinner: without it a reload mid-call shows an untouched draft and invites a second
  billable attempt.
- **Sonnet, not Haiku.** The classifier's small model is right for bounded-choice labelling
  over thousands of rows; this is one call per authored skill and the output *is* the
  product. A cheaper draft the author rewrites costs more than the model did.
- **Temperature 0.4, not 0.** Labelling wants determinism for R7.2. Writing does not — at
  zero, "write it again" hands back the same document and the button is a lie.
- **Drafts are validated by the same analyzers the registry runs** (R4.5), through a new
  `runAnalyzersOnBundle` seam. `AnalyzerInput` already took files rather than a storage key,
  so a draft is judged before it is stored anywhere — no persisting an unvalidated skill in
  order to validate it. R2.3 is excluded: it compares documentation against bundled code,
  and a text-only first draft has none.

**R5.5's refusal is a field in the structured output, not a filter around it.** A post-hoc
check would mean paying to write the thing first and then reconstructing the refusal from
prose. The model returns a body *or* a reason; either way an `events` row is written, which
is what makes "the assistant refuses malicious authoring" checkable rather than asserted.
Verified against a real brief asking for disguised credential exfiltration — refused, with
the reason naming the disguise.

**Domain is collected but is not part of the scaffold.** Worth stating because the opposite
is the natural assumption: archetypes are mined on the **function axis only** — all 53 rows
are `axis = 'function'`, and every mining and reading query filters on it. Structure follows
function, so a contract review and a pull-request review share a skeleton; mining per domain
would average a rubric together with a template and fit neither.

What domain *does* affect is the two things the function axis cannot:

- **content.** A review skill for legal and one for code share a shape and share no
  vocabulary. The prompt receives it inside a `<domain>` tag that says, in the tag itself,
  to use it for wording and examples and **not** to change the section structure — the
  skeleton is the measured part and this is not.
- **publishing.** R3.1 wants both axes on a skill and browse runs on domain, so a draft
  promoted into the corpus without one would be uncategorised on the axis people filter by.

It sits in step two beside the purpose rather than in a step of its own — a whole step for
one optional dropdown is friction for no gain — and stays nullable, because a skill can be
genuinely domain-neutral and a guess would mislabel it.

**R5.2 traceability runs all the way down.** Each section carries its prevalence into the
UI *and* into the prompt, so the model is told which sections earned their place by a
measured margin and which are merely conventional. A category with no mined archetype falls
back to a plain skeleton with `lift: null`, and both the form and the prompt say so — no
inventing evidence for the categories that have least.

> **A scope bug the builder found.** `archetype-read` pins `org_id is null` and calls itself
> public, then resolved its exemplars through `withOrgScope`. That widened the list for a
> signed-in viewer *and* made a public read impossible outside a request, because
> `withOrgScope` resolves a session — which is how it surfaced: `buildScaffold` threw on
> `next/navigation` in a plain node process. `getSkillsByIds` now takes `publicOnly`.

Not built: multi-dialect export (R4.4), publishing a draft into the corpus, and the
conversational refinement pass. The draft is written, validated and stored; turning one into
a served skill is the next piece.

### The FAQ is generated from the code, not written beside it

`/faq`, public, third item in the sidebar and the anonymous header. It answers the questions
the interface raises and never answered: what 100/100 means, why a badge is amber, why one
skill downloads and another does not, what "quarantined" implies, where categories come
from, what lift is.

**Almost nothing on that page is prose about values — the values are imported.** Categories
from `FUNCTIONS`/`DOMAINS`, capabilities from `CAPABILITY_META`, licence postures from the
module the badges render from, section roles from `SECTION_ROLE_META`, severity weights and
the substance curve from `lib/quality.ts`, the analyzer list *and versions* from
`ANALYZER_VERSIONS`, the evidence gate from `EVIDENCE_GATE`, the confidence floor from the
taxonomy vocabulary.

That is the only way a page like this survives contact with a moving codebase. Documentation
that restates constants is wrong within a month, and a reader who checks one number, finds
it stale, and stops trusting the rest has lost more than the page ever gave them. Move a
threshold and the page moves with it or fails to compile.

> **`lib/quality.ts` came out of this.** The severity weights and the substance curve lived
> inside `scoreOf`, and the badge's 90/70 colour bands lived in the registry page — so
> explaining the score meant copying both. They are now one leaf module used by the scorer,
> the badge and the FAQ. A legend that disagrees with the badge it explains is worse than no
> legend.

An analyzer added without a blurb still renders, with no description rather than being
absent from the list. Missing prose is obvious; a missing row is not.

**Badges link into it**, via `components/registry/explain.tsx`. Anchors are a typed
`FaqAnchor` from `lib/faq.ts`, shared with the page's own headings, so renaming a section
breaks the build rather than silently scrolling nowhere — a broken explanation is worse than
an unexplained badge, because the reader has already decided to trust the answer.

> **Where a badge may not be wrapped.** Each row in the registry list is inside a card-level
> `<Link>` to the skill, and an anchor inside an anchor is invalid HTML: browsers disagree
> about what the click means and the card's own navigation stops being predictable. So the
> list gets **one** plain link near its filters, and only the detail pages wrap individual
> badges. Checked, not assumed — the rendered list has zero nested anchors.

Category badges keep their existing link into the registry filter. Browsing the rest of a
category is more useful than a definition, so the definition gets its own quiet link rather
than taking that over.

### Archetypes are public now (R3.2–R3.4)

`/archetypes` and `/archetypes/[category]`, in the `(public)` group alongside the registry
and absent from the `proxy.ts` matcher for the same reason. Doc 1 licenses archetype
snapshots CC BY-SA and sells the *live API* and org-scoped blends, so the pages belong on
the free tier — they are the argument for the platform, and until now the argument was a
database table.

Server components throughout: no state, nothing to filter, nothing to toggle.

- **Read path** is `src/server/analytics/archetype-read.ts`, separate from `archetype-run.ts`
  because mining and rendering have opposite risk profiles. Every read pins `org_id is null`
  *and* runs in `withPublicScope`. Either alone would do today; both are there because
  OQ-C2 answers "may org-private archetypes feed public ones?" with *never*, and that
  default should be visible in the code that would break it.
- **Exemplars (R3.3) resolve live.** The row pins ids so the mine stays reproducible;
  `getSkillsByIds` in the DAL turns them back into skills and drops anything no longer
  `indexed`. An exemplar quarantined since the mine must stop being held up as good
  practice, and a stored name would go on recommending it forever. The count of dropped
  ones is shown, not swallowed.
- **The one chart** draws both bands on the same track, always. A single prevalence bar
  would say "55% of review skills have a when-to-use section" — a fact about markdown. The
  gap between the two bars *is* the lift, which is the finding.
- **Categories below the gate are listed, not hidden.** `automate-browser` sits at 43
  structures against a floor of 50 and gets a tile saying so. Twelve tiles and a clean grid
  would look finished and would tell an author nothing about where the corpus is thin.

**Miner 2.1.0 records who an archetype was derived from** (R3.4) — the sources behind the
numbers, credited in **distinct structures**, the unit the mine measures in. Crediting by
skill count would put the 89%-of-corpus generator at the top of every list having taught the
skeleton one thing.

> **A miner bump has to beat the skeleton-match skip, or new evidence never lands.**
> `mineAndStore` skips writing when the skeleton is unchanged, which is right as the corpus
> drifts and wrong across a version bump: every stored row already had the skeleton it was
> going to keep, so 2.1.0's attribution would have reached exactly zero archetypes,
> silently. `--force` would not have helped — it only bypasses the evidence gate. The skip
> now also requires `minerVersion` to match. `minerVersion` is stored so "reproducible"
> means something; it has to be able to change the answer, or storing it is decoration.

**What the pages immediately showed.** `edit-refactor` clears the gate at 70 structures /
27 sources and produces a **one-section skeleton** — only `purpose`, at +25. That is the
thin archetype CLAUDE.md flagged, and it is reported as thin rather than padded: the other
twelve roles were measured and none separated the bands. Worth re-reading after full
ingestion, when v5-vs-v6 answers how much the sampled weak band was distorting it.

### Takedowns (R7.5) — the whole difficulty is that a sync must not undo it

`src/server/compliance/takedown.ts`, Settings → **Takedowns**, `pnpm verify:takedown`
(14 checks). P0 compliance: we mirror other people's work, and Doc 1 states the obligation to
upstream authors — who never signed up — as structural.

Withdrawing content is the easy half and the tombstone path (R1.5) already does it. Reusing
it would have looked finished and been wrong. **A tombstone is designed to reverse itself** —
the file went away upstream, and if it comes back the next enumeration re-indexes it. Run
that logic on a takedown and the content returns within 24 hours, on a schedule, with nobody
watching.

So a takedown is a **persistent record consulted before fetching**, and the state on the
skill is a consequence of it:

- `takedowns` (migration 0009) keys the block on **`(source_url, skill_path)`**, duplicated
  out of the join columns on purpose. That pair is the identity `syncSource` matches an
  existing skill on, and the block has to work when the rows it was recorded against are
  gone. Keyed on `skills.id` it would be lifted the first time a skill row was rebuilt.
- **Not the content hash**, tempting as it is with content-addressed storage: an author who
  edits the file after asking us to remove it produces a new hash and walks past the block.
  Path identity survives an edit; a hash is designed not to.
- `activeBlocks(sourceUrl)` runs in `syncSource` **before enumeration**, and again per skill
  before `connector.fetch`. Content we were asked to stop copying is not copied into memory
  either.
- Only `upheld` enforces. A `received` notice is logged and unenforced — enforcing on arrival
  means anyone who can send an email can un-list a competitor, which is the failure every
  takedown regime is criticised for. Recording and deciding are separate actions in the UI
  for the same reason.

**`withdrawn` is a new status on both skill enums, not a reuse of `tombstoned`.** Same end
state, different re-ingestion rule, and different notice to a reader: "the author deleted
this" and "this was removed following a request" are not the same sentence.

> **The new status silently changed dedup, and that needed migration 0010.**
> `skill_versions_content_hash_uq` is a *partial* unique index — `where status <>
> 'tombstoned'` — so a withdrawn row would have held its hash slot forever while holding no
> bytes, and an **unrelated** repository shipping an identical file would fail to index with
> a unique-violation nobody could trace to a takedown on someone else's copy. The block is
> deliberately keyed to the `(source, path)` a claimant named; the index must not turn it
> into a global ban on the bytes.

**What is deliberately kept:** rejected claims (a refused claim is still a claim that was
made, and that record is the half of this that protects the platform), and the page itself.
A withdrawn skill keeps its permalink and shows grounds and a date — R8.4 wants citations to
keep resolving, and a URL that silently 404s tells a reader nothing about whether the skill
was dangerous, deleted, or withdrawn. **Never the requester or the claim text**: naming the
requester turns a compliance record into a pillory, and quoting the claim republishes an
allegation we have not adjudicated.

Download returns **451**, not 409, with its own `withdrawn` reason — a quarantined skill may
pass on a later version, a withdrawn one will not, and that is the difference between "retry
tomorrow" and "stop asking". Archetype exemplars need no special case: `getSkillsByIds`
filters to `indexed`, so a withdrawn exemplar drops out on its own.

Reinstating lifts the block and rests versions at `tombstoned` — **it does not restore
content**, because the bytes were deleted. The next sync re-fetches and re-validates. A
function claiming otherwise would be lying about R2, and flipping to `indexed` would leave a
skill that lists as servable and 409s on download.

> The bundle-deletion guard checks whether another *stored* version shares the hash before
> deleting. Honest status: **it cannot currently fire**, because the two statuses that escape
> the partial unique index also clear `contentStored`. That is three conditions holding in
> three files, guarding an irreversible delete, so the query stays — and `verify:takedown`
> does *not* fake the state to make it green.

**Still admin-entered.** A notice arrives by email and a curator records it. A public
submission form is the obvious next step and is not built; R1.8's public-submission plumbing
is the natural place to hang it.

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

### The marker threshold, and re-applying a policy change

`markerCountReviewThreshold` is **500** (was 50). At 50 it paused 32 sources in one go —
61, 66, 84, 90, 102, 120, 193 markers — which are ordinary large collections, not datasets,
and exactly the mass categorical and structural analysis needs. The gate exists to stop the
crawl quietly ingesting a monorepo nobody looked at; it was instead capping the corpus.

Size was also standing in for a property it does not measure. Structural monoculture is what
damages archetype mining, and `minStructuralDiversityPercent` measures that directly now, so
the size gate only has to catch the genuinely enormous — where the mass fetch is itself the
risk.

**A threshold change is not finished until the already-decided rows are re-judged.** A
paused source is `enabled = false`, so `pendingSources` skips it forever; raising the number
would silently apply only to repositories discovered *next*. `reapplyMarkerThreshold()` is
the sweep, sibling to `reapplyPathExclusions()` — offline, free, re-runnable in either
direction, and it leaves `allowLargeRepo` sources alone because a curator already decided
those.

> `discovered_repos.hit_count` is **not** the marker count. It is what *code search*
> reported — capped and sampled — while the pause records what a full enumeration found.
> Using one as a fallback for the other let a repository whose enumeration found 3,551
> markers past a 500 threshold, because code search had seen only a handful. The sync
> re-pauses it, so nothing is fetched, but the sweep then reports "0 still held" when two
> were — a lie in the one number you are reading to check the change worked.

### The registry is public, and downloads are real

**`(public)` vs `(protected)` is the whole boundary.** `(public)/layout.tsx` calls
`getSession()` — which returns null — where `(protected)/layout.tsx` calls
`requireSession()`, which redirects. A signed-in visitor gets the full sidebar chrome; an
anonymous one gets a plain header. Same registry underneath. `/skills` is deliberately
**absent from the `proxy.ts` matcher**; putting it back would redirect anonymous visitors
away from the pages that exist to be read by anyone.

Nothing extra was needed in the DAL: `withOrgScope` resolves no org for an anonymous
request, which lands on exactly the public corpus (`org_id IS NULL`) with RLS enforcing it
rather than a `where` clause someone can forget.

**Export (R8.2) is the delivery half of R2.6.** Content-hash lockfile semantics were a
claim until something handed a consumer bytes. `pnpm verify:export` proves the contract
(10 checks); the properties that matter:

- the archive is assembled from the objects at `sha256/<hash>/…`, so the key *is* the hash
  the verdict covers;
- it carries `SKILL-FOUNDRY.json` with the content hash, the **validation report hash**, and
  the verdicts that hash covers — both recomputable from the archive alone;
- **two downloads are byte-identical.** This cost a design change: the receipt originally
  embedded `exportedAt`, which made every download differ and destroyed the one property a
  consumer can actually check. `syncedAt` is the timestamp with information in it. ZIP
  mtimes are pinned to 1980-01-01 for the same reason (the format cannot encode the epoch).
- the licence gate runs **before any object is read**. `metadata_only` and `unresolved`
  skills have no stored copy at all — analysed in memory, verdict kept, text never written
  down — so the refusal is a fact about the licence, and it returns 451 with a link to
  origin rather than a redirect that would look like a successful download.

**Why the download is a route handler.** Queries belong in `src/server/**` called from
server components and actions, and route handlers get no database — both hold: the route
imports `@/server/skills/export`, touches no `@/server/db`, `drizzle-orm` or `pg`, and scope
is still resolved in the DAL. A file download cannot be a server component (renders HTML) or
an action (returns a serialisable value), so this is the exception the rule anticipates. The
reasoning is in the route file so nobody has to rediscover it.

> `export.ts` is split into `buildBundle` (takes facts, assembles) and `exportSkill` (looks
> facts up through the DAL) because the DAL reaches `next/navigation` and cannot load in a
> plain node script. Assembly is the part with rules worth testing.

### `pnpm typecheck` must generate route types first

`PageProps` and `LayoutProps` are **generated**, not imported. Next writes them into
`.next/types/routes.d.ts`, and `tsconfig.json` picks them up through its `include`. A clean
checkout has no `.next`, so `tsc --noEmit` alone fails with eight `TS2304: Cannot find name
'LayoutProps'` — which is exactly what the Vercel build hit, while the same command passed
on every machine that had ever run `next dev`.

`typecheck` now runs `next typegen && tsc --noEmit`. `typegen` generates the route
definitions without a full build, so the check is correct from a clean tree.

> Worth knowing how this hid: locally it passed for two reasons at once — `.next/types`
> lingering from earlier builds, and `"incremental": true` with a committed
> `tsconfig.tsbuildinfo` returning a cached pass. Deleting `.next/types` alone was not
> enough to reproduce it, because `tsconfig` also includes `.next/dev/types`, which the dev
> server maintains separately. Reproducing it needed the whole `.next` directory gone.
>
> When verifying a CI failure locally, remove `.next` **and** `tsconfig.tsbuildinfo`, or the
> green result means nothing.

### A scheduled pass cannot start a source it may not finish

The first live cron run died with `FUNCTION_INVOCATION_TIMEOUT` after the full 800 seconds,
mid-fetch on a single repository. Worse than the failure: a timed-out source is never marked
synced, so the next tick would have picked the same one and died again — **every ten minutes,
indefinitely**, burning function time and never advancing.

`syncBudgetMs` could not prevent it. That budget is checked *between* sources, and one
oversized source runs to completion or to the platform's kill regardless. The check has to
happen before the fetch begins, because a source must be fetched **completely** — a partial
enumeration would make R1.5 tombstone every skill it did not reach.

So `syncSource` takes `maxSkills`, and enumeration (two API calls, already paid for) decides.
Over the limit, the source is **held for review** — the queue a curator already watches —
and synced deliberately with `pnpm sync <url>`, which has no ceiling. The scheduled pass sets
120; manual runs set nothing.

> Reading the logs correctly mattered here. The first invocation I saw was `curl/8.7.1` at
> 401 — my own deployment check, which I misread as the cron working. The real one is
> `vercel-cron/1.0`, and it was failing. `User-Agent` is what distinguishes a scheduled
> invocation from a manual probe, and the 12-hour observability window can be empty simply
> because the schedule has not ticked yet.

### The ingest schedule (R1.7)

`vercel.ts` runs `/api/cron/pipeline` every ten minutes; the route runs one bounded pass and
returns what it did. That is the whole scheduler — no queue, no worker, no state machine.
Every stage is already resumable and idempotent, so "run a slice periodically" is a complete
implementation rather than a placeholder for one.

**The schedule is for freshness, not catch-up.** Twice a day (05:00 and 17:00 UTC), six
sources a pass. Initial ingestion runs from a local machine, where there is no function
ceiling and a 2,000-skill repository can take the hour it needs; a schedule racing that same
queue would duplicate every fetch and contend for the same rows.

What it *is* for is the part nobody remembers: R7.4 asks that upstream changes be detected
within 24 hours. Two passes a day against a 24-hour staleness window picks up a due source
within twelve, with margin for a failed pass. It also keeps compute honest — ten minutes is
144 invocations a day whether or not anything is due; this is two.

### `pendingSources` had one job and it was the wrong one

It selected `lastSuccessAt IS NULL` and nothing else, so the scheduler could only ever do
**initial catch-up** and went permanently idle the moment it finished. No drift detection,
no revocation, no freshness — R7.4's target was unreachable by the only thing running on a
timer, and nothing would have reported that.

It now returns never-synced sources **first**, then any whose last success is older than the
freshness window. Never-synced first because a source contributing nothing is a bigger gap
than one a day out of date, and because it keeps a catch-up run doing catch-up. When that
queue empties the same query starts returning stale sources and the schedule becomes a
freshness loop, with no change in behaviour anywhere else.

**`CRON_SECRET` gates it, and the route fails closed when it is unset.** Vercel sends it as
a bearer token. Without the check this is an unauthenticated endpoint that makes us fetch
hundreds of repositories on demand — a denial-of-wallet against our own GitHub budget — and
refusing on a *missing* secret is the only safe default, since the alternative is a
deployment that is quietly unprotected exactly when someone forgot to configure it.

**Nothing that costs money is scheduled.** The R2.3 analyzer and the taxonomy classifier
stay manual. A schedule that quietly spends is one nobody can leave switched on; they can
join it once RC.2's spend caps exist to bound them.

Every pass writes an `events` row (`pipeline.completed` / `pipeline.partial`) tagged with
its trigger — `cron`, `admin` or `cli` — and Settings → Ingestion renders the last few.
A schedule you cannot observe is one you cannot trust: "it is running" and "it has been
failing since Tuesday" look identical from the outside.

### A slice is bounded in time as well as count

The pipeline's sync stage takes N sources — which is not a bound at all when one source can
be arbitrarily large. `davila7/claude-code-templates` holds 898 skills, roughly 3,600 file
fetches, and `syncSource` deliberately fetches a source *completely* (a partial enumeration
would make R1.5's tombstoning delete everything it did not reach). One source in a
five-source slice outran the job's wall clock and the whole loop was killed mid-pass —
twice, at exactly the same source.

`syncBudgetMs` (8 minutes) is checked **before starting a source, never during**. A source
in flight is fetched to completion or not at all; the budget stops the *next* one starting,
which caps the overrun at one source rather than the queue, and the stage reports
`N deferred, time budget spent` instead of dying.

### One bad skill must not cost the repository

`syncSource` had no per-skill error handling: a single throw inside the fetch loop aborted
the source. The same repository proved it — one directory
(`cli-tool/components/skills/ai-research/loki-mode`) trips the 300-file bundle backstop
because detection reads a project as a skill, and that one throw **lost the other 897
skills**. Twice. Reported only as `2 failed` in a pipeline summary, which is why it went
unnoticed for several passes.

Failures are now per-skill, collected into `report.failedSkills` with the path and the
reason, and named in the CLI rather than counted. The same run now syncs 149 and skips 1.

Tombstoning stays correct because `seenPaths` is built from the **enumeration**, not from
what was successfully fetched — a skill that failed to fetch is still *seen*, so it is never
mistaken for one deleted upstream.

### Run the pipeline, not the stages

`pnpm pipeline` / Settings → Ingestion → **Run the pipeline** does
sync → validate → fingerprint → signatures → cluster in one bounded pass. The individual
stage commands still exist and are still right for tuning one threshold at a time, but they
are not how the corpus should be advanced.

Running them separately is how the derived data drifted: **fingerprints fell 1,566 behind
the corpus and dedup signatures 2,240**, each gap widening with every sync, because the
loop being run was sync + validate and nothing else. Neither shortfall raises an error —
they look like a smaller corpus. And both starve the next phase: archetype mining reads
fingerprints, and only *canonical* skills get classified, so a missing signature quietly
keeps a skill out of the taxonomy too.

The order is a dependency chain, not a preference: each stage consumes what the previous
one produced. A stage that throws is recorded and the rest still run — a GitHub rate limit
during sync must not also cost the fingerprints of everything already fetched.

### Re-scan campaigns (R2.12)

`pnpm rescan --status` shows, per analyzer, how many skills carry a verdict from a
superseded version. `--run N` re-judges a bounded slice. Free: rules only, and the LLM
analyzers are deliberately never re-run by a campaign — a `structural-lint` fix is no reason
to pay for a fresh R2.3 audit of the same skill.

The selector is **every version whose newest verdict predates the analyzer's current
version**, not "skills that look affected". That distinction is the point. `structural-lint`
went 1.0.0 → 1.3.0 in one session and each fix was chased with a throwaway script targeting
whichever slice seemed relevant — which left **4,179 behind**, all the skills that *passed*
under the old rules and so were never in any slice anyone thought to check.
`ANALYZER_VERSIONS` is derived from the analyzer objects, so the current version cannot
drift from what actually runs.

> **What the first campaign found: nothing.** 300 re-judged, **0 status changes, 0 score
> changes.** I had claimed those 4,179 carried stale quality scores; they did not. The
> `structural-lint` fixes only ever removed *blocking* findings from skills that were
> already quarantined, and those had been re-validated at the time — a passing skill had no
> such findings to lose. The mechanism is still right to have, and the version stamps are
> worth correcting so the freshness number is honest, but the specific alarm was overstated.

### Validation — what runs by default, and what does not

`validatePending()` runs four **free, deterministic** analyzers: structural-lint,
secret-scan, injection-scan, capability-surface. That set has to stay free, because a
validate pass you have to think about before triggering is one that stops getting triggered.

**R2.3 description-consistency is opt-in** (`includeCostly`, `pnpm validate --consistency`).
It asks a model whether the documentation honestly describes the bundled code — the blind
spot the other four structurally cannot cover, since a script posting to an external host is
fine in a skill that says it uploads reports and alarming in one that says it formats
markdown. Two things keep it affordable: it targets only bundles that contain code
(`versionsWithCode()`; ~7% of this corpus), and a bundle with no code returns a pass with no
model call — which is the correct answer, not a cost dodge.

Its thresholds are deliberately timid: `fail` below 35, `warn` below 70. Quarantine
precision is a tracked metric, and a model that is merely unsure should produce a warning a
human reads, not a block. The hard blocks stay with the analyzers that have no opinions.

### Git symlinks are not documents

A symlink is stored in git as a blob **whose content is the target path**. Over
raw.githubusercontent.com that is literally what comes back — `../../../.config/agents/rules/panda-css.md`
— not the file it points at. Treated as an ordinary blob it becomes a 40-byte "skill" whose
entire body is a path, which is then hashed and stored.

Found by spot-checking a quarantine count that looked too round: **217 of the 245 skills
quarantined for "no frontmatter block" were symlinks.** They were in quarantine, which was
the right outcome for the wrong reason — the verdict said `missing-name` when the truth was
that we had ingested a pointer.

The GitHub tree API reports `mode: 120000` for them and the connector was discarding the
field. `isSymlink` now filters them out of enumeration. Skipped, not resolved: nearly all
point *outside* the skill directory at files the crawl reaches on their own terms, and
following arbitrary relative paths out of a bundle is a directory-traversal problem we would
be choosing to have.

**The cleanup needed no special case.** A skipped symlink is absent from the next
enumeration, which is exactly what R1.5 tombstoning means by "gone upstream" — re-syncing
`hashintel/hash` retired its four (36–42 bytes each) automatically, metadata retained. The
rest clear as their sources re-sync.

> The indexed side was checked too, and is clean: a sample of tiny indexed skills were all
> legitimate — real frontmatter, just terse. Nothing was being served as a skill that was
> actually a path.

### Identity blocks; convention warns

The rule `structural-lint` applies to identity is **"can this skill be identified at all"**,
not "does it follow the convention". The normalizer's fallback chain — frontmatter, then the
leading heading, then the directory name — already answers the first question for every
dialect, and it had been answering it correctly while nothing read the result.

| Situation | Verdict |
|---|---|
| Frontmatter complete | pass |
| No `---` block, name derivable | `frontmatter-absent` · **medium** · indexed |
| Block present, `name` omitted, derivable | `missing-name` · **medium** · indexed |
| No `description`, summary derivable | `missing-description` · **medium** · indexed |
| Nothing anywhere identifies it | **high** · quarantined |
| Nothing anywhere describes it | **high** · quarantined |

Blocking is for *safety*, and a missing YAML block is not a safety question — every security
analyzer runs and passes regardless. Hiding 257 real skills over a convention was a quality
decision wearing a trust decision's clothes.

It stays a real defect and is priced as one: two `medium` findings cost 16 quality points,
so these land at **84/100** and rank below well-formed skills without disappearing.
`description` is what a consuming agent matches on in the Agent Skills standard, so a skill
without one genuinely triggers less reliably.

**Released 257.** The 8 that still block are 13–64 byte stubs and symlink remnants — a name
from the directory, but no content to summarise, so nothing decides when they would trigger.

> The message has to match the fault. "No YAML frontmatter block" is wrong when the block is
> right there and merely omits `name`; that sends an author looking in the wrong place. The
> two cases carry different reasons and different wording.

### Absent frontmatter and malformed frontmatter are different faults

`invalid-frontmatter` exists because ten skills were reported as `missing-name` +
`missing-description` while having both fields plainly present in the file. The block was
there and failed to parse — almost always a colon inside an unquoted value, where
`description: Digest of posts on [REPLACE: TOPIC]` makes YAML read `[REPLACE: TOPIC]` as a
nested mapping and reject the document. One pair of quotes fixes it, and nothing in the old
verdict pointed there.

`splitFrontmatter`'s `"no frontmatter block"` is absence and still reports `missing-name`;
anything else is malformation and reports the parse error with the message. Both are pinned
by `validate:verify` cases, in both directions.

### Analyzers are dialect-aware, because the dialects have different contracts

`structural-lint` used to read `frontmatter.name` and `frontmatter.description` and block
when either was absent. That is the SKILL.md contract, and it was applied to everything —
so **121 of 121 AGENTS.md files in the corpus were quarantined**, all for `missing-name` and
`missing-description`, both blocking. AGENTS.md is plain markdown *by specification*: it has
no frontmatter block at all. The files were fine; the rule was wrong about what it was
reading, and an entire dialect was invisible to the registry as a result.

`AnalyzerInput` now carries `dialect`, `resolvedName` and `resolvedSummary`. The last two
are identity as the **normalizer** resolved it — frontmatter, then the leading heading, then
the directory name — which had been working correctly all along, producing names like
"Agent Configuration — Contributor Rules" that nothing ever read.

The rule an analyzer should apply is *"does this skill have a name"*, not *"does this YAML
key exist"*. Those are the same question for exactly one dialect.

- `anthropic_skill` / `claude_plugin` — frontmatter is the contract; missing keys still block.
- everything else — identity must be derivable from somewhere, and an empty document still
  blocks; a missing summary is a `low` note, because an AGENTS.md is instructions for an
  agent already in the repo, not a skill matched from a description.

Re-validating released **120 of 121**. The one still quarantined is `windmill`'s AGENTS.md,
for a database URL with credentials — a true positive from secret-scan, exactly what should
still block.

Two `verify:analyzers` cases pin this: an AGENTS.md with no frontmatter must pass, and a
SKILL.md with no frontmatter must still fail.

> The registry's dialect filter had disappeared while this was broken — one option covering
> everything is a no-op control, so it hides itself. It came back on its own once the 120
> were released, which is the behaviour a self-correcting facet should have.

### Revocation and drift (R1.5) — three rules that were each broken

`pnpm verify:revocation` proves all three.

1. **A failing new version never withdraws a good one.** `validateOne` used to set
   `currentVersionId = null` on any quarantine, so one bad upstream push de-listed a skill
   that had passed — an upstream author could break our listing without touching anything we
   had approved. It now falls back to the newest still-indexed version.
2. **A changed version is `revalidating`, a new one is `pending`.** Both unserved, both
   queued; the distinction is that "upstream changed under us" and "never seen before" need
   different operational responses and one bucket cannot express which happened.
3. **Deletion is detected only on a complete enumeration.** `tombstoneMissing` withdraws
   content and keeps metadata — but a `--limit`ed, dry, or `includePaths`-narrowed run is a
   partial view, and treating one as authoritative would tombstone everything it did not
   look at, silently, one truncated sync at a time.

Related fix: `includePaths` stored on a source was **never read back** by `syncSource` —
only `allowLargeRepo` was. Narrowing `liferay/liferay-portal` to `workspaces/` was recorded
and then ignored by every sync that did not re-type `--include`. Both are now read from
`sources.config`, with an explicit argument winning.

### Discovery — how sources are actually found

Four channels, in descending order of precision (Doc 4 §4). The order matters: the precise
ones are cheap and produce a *quality-biased* corpus, which is what archetypes should be
learned from.

| Channel | State | Command |
|---|---|---|
| 1. Seed allow-list | ✓ `src/server/crawl/seeds.ts` — 18 repos, 5 lists | `pnpm seed --repos` |
| 2. Curated-list expansion | ✓ `src/server/connectors/awesome-list.ts` | `pnpm seed --lists` |
| 3. GitHub code-search crawl | ⚠️ built, ~1% covered, **cannot finish** | `pnpm crawl` |
| 4. Registry reconciliation (ClawHub, skills.sh, LobeHub) | ✗ not built | — |

**Why 3 cannot finish.** GitHub reports 381,952 SKILL.md files. Search caps every query at
1,000 results, so the space is sharded by file size — and 38 shards are `saturated`: over
the cap and no longer splittable on that axis, covering 383,662 reported results. Finishing
needs a *second* shard axis (path, created-date, language). Parked deliberately: 382k
markers is mostly noise, and the top few thousand is what matters.

**Why 1 and 2 exist.** Size-sharding is arbitrary with respect to value, so the crawl has
no way to reach the good repositories first. `garrytan/gstack` — 130k stars, MIT, 59 skills —
was reached by neither the crawl *nor* any of the four major awesome lists. Only a
hand-picked list catches that, which is exactly why Doc 4 puts it first.

Measured when the seed list was added: 14 seed repos → 1,406 skills reachable, and the
licence mix (MIT, Apache-2.0) is far better than the pre-existing corpus at 96%
`attribution_required`. Four curated lists → 277 candidates, 50 of them new.

**Sources for the seed list come from `specs/skill-registries/`.** Every entry is verified
against the GitHub API before it is hardcoded — that file is a human-written list and has
been wrong: `forrestchang/andrej-karpathy-skills` is a 404 (the real repo is
`multica-ai/andrej-karpathy-skills`), three entries name no repository at all, and
`hesreallyhim/awesome-claude-code` is a list rather than a skill repo. `SEED_REJECTED`
records each of those with its reason so nobody re-checks them.

**`holdForReview` on a seed entry** is for repos worth having that are big enough to
unbalance the corpus alone — `davila7/claude-code-templates` (898) and
`alirezarezvani/claude-skills` (846) would each be about a third of it. They enter the
review queue instead of promoting: a decision about *when*, not about quality.

**An admin submission satisfies the large-repo gate.** `markerCountReviewThreshold` exists
to stop the *crawl* ingesting a monorepo nobody looked at; someone typing the name into the
admin form is that look. Without this the two gates disagree — submission promotes,
`syncSource` then refuses and disables the source, which is exactly what happened to
`aws/agent-toolkit-for-aws` at 155 markers. Re-submitting also re-enables a source a
previous run paused.

**A list is a discovery source, not a content source.** `awesome_list` sources are read for
the repo links inside them by `expandList`, and are excluded from `pendingSources` — syncing
one would try to ingest the list repository's own README as a skill.

### TODO — LLM-assisted source discovery from the open web

Channel 5, not yet designed. The three built channels all require someone to already know a
URL. What they miss is the thing that actually happens: a skill pack gets popular on X, in a
newsletter, on Hacker News, in a Discord, and nobody adds it here for weeks. `gstack` is the
worked example — 130k stars and invisible to every automated channel we have.

Shape it should take:

- a scheduled search across the open web and social sources for people *talking about*
  agent-skill repositories, not for the repositories themselves;
- an LLM pass that extracts candidate GitHub URLs from that chatter and discards the noise;
- everything it finds enters as an ordinary `discovered_repos` candidate at
  `status: "new"` — **never auto-promoted**, because the source of the tip is untrusted and
  a popularity signal is not a quality signal;
- the tip itself recorded as provenance (where it was mentioned, when, by whom) so the
  curator judging it can see the evidence.

Cost and prompt-injection posture are the open questions: search results are untrusted input
in exactly the sense R7.3 means, and this would be a recurring spend rather than a one-off.
Both are reasons to build it *after* the corpus is balanced, not before.

### Section presence stopped discriminating, and the threshold had to learn to scale

`pnpm verify:archetypes` (20 checks, free) · superseded by miner 3.0.0 below · this is the v8 story

The first mine over the fully-labelled corpus produced **five archetypes with zero sections**
and eight more with one or two. `--mine-all` printed thirteen ticks and a list of dropped
sections; `/build` and `/archetypes` served the result. Nothing errored.

**It was not a bug.** At 8% corpus coverage the weak band wrote `steps` in 47% of structures
and `references` in 24%. At 97% those are **67% and 55%**. The strong band barely moved. Lift
is strong minus weak, so it collapsed — `integrate-api`'s `references` went from 66/24 (lift
42) to 66/58 (lift 8).

The old numbers were the unrepresentative ones. v6 was mined from ~4,101 skills chosen by the
`diverse` round-robin, which over-samples *small* sources, and small sources write terser
documents. The full corpus does not.

> **The obvious culprit was wrong, and testing it took four minutes.** Suspecting a generator
> flooding the weak band — `kbarbel640-del` alone supplies 34% of `integrate-api`'s — a
> per-source cap was implemented and measured at three strengths. Lifts got **worse** as the
> cap tightened (references +10 → +6 → −3 at caps of 25/10/5), which rules concentration out
> entirely. The cap was reverted. Distinct-structure dedup does not save you here either: it
> collapses *identical* signatures, and a farm emitting 793 subtly-different shapes survives
> as 793 data points.

**What did need fixing was `MIN_LIFT`.** It was a flat 12, set when a band held ~90
representatives and the standard error on a prevalence difference was ~7 points. Bands are now
~300 strong against ~2,300 weak, where that error is ~2.8 — so 12 had silently become a
4-sigma test. It is now **three standard errors plus an 8-point floor**: statistically real,
*and* large enough to be worth telling an author about. The threshold scales itself with the
evidence; on a thin category it now demands 20 or more, which is what the flat number was
reaching for and could not express.

Retuning recovered sections in seven categories and confirmed the finding anyway: **the best
section lift across the three largest categories is +10, where traits reach +35.**

**So the discriminator moved from headings to bundle structure.** Everyone writes `steps` now.
Not everyone ships a real `references/` and links to it:

| review v8 | strong / weak | lift |
|---|---|---|
| Links to its own bundled files | 44% / 21% | **+23** |
| More than one file | 65% / 52% | +13 |
| Offloads detail into `references/` | 45% / 33% | +12 |

That is better guidance than a heading list, and it only became visible at full coverage.

**Anti-patterns are zero across twelve of thirteen categories, and that is real.** Every
measured trait is positive: curated skills are strictly more thorough, so nothing is *more*
common in the weak band. Checked rather than assumed, because a symmetric measurement
returning zero on one side looks like a filter bug.

> **`stats.measured` now stores every role considered** — its bands, its lift, the threshold
> it was judged against and why it was rejected. Previously `stats.sections` held only what
> passed, so a section that missed by two points left no trace, and diagnosing this took four
> throwaway scripts rebuilding numbers the miner had already computed and discarded.
>
> `verify:archetypes` asserts **"every archetype carries sections or traits"**, not "sections
> exist". The corpus is allowed to have no structural consensus; what it may not do is
> scaffold an empty form. That distinction is the whole bug: the measurement was right and the
> output was unusable, and only the first had anything checking it.

### And then blocks discriminated, which is what the section collapse was pointing at

`pnpm verify:archetypes` (20 checks, free) · miner **3.0.0** · v9, review v10

The section finding above ends with an unanswered question. Everybody writes `steps` now, the
best section lift across the three largest categories is **+10**, and traits reach +35 — so
the shape of the *document* had stopped being the interesting part. Doc 6 §2 bets that the
discriminator moved one level down, into what the passages inside those sections are doing.

**The bet holds, and by roughly a factor of two.** Measured with the miner's own bands,
representative reduction and significance rule — not a second copy of them:

| block type | categories earning a place | median lift |
|---|---|---|
| `reference-pointer` | 11 of 13 | **+19** |
| `decision-rule` | 10 of 13 | **+22** |
| `guardrail` | 6 of 13 | +15 |
| `output-spec` | 6 of 13 | +15 |
| `tool-contract` | 4 of 13 | +14 |

`review` is the clearest single case: five block types clear the bar where two sections do,
and density adds a dimension presence cannot reach — a curated review skill carries **4.3
procedures against 3.2**, and nearly twice the reference pointers.

**An archetype is now a grammar rather than a heading list.** Which block types, in the order
the strong band writes them, at what lift, with the count beside it. It reaches an author
three ways, and all three had to be wired or the mine would have been a database row again:
the block card on `/archetypes`, a read-only list in the builder's sections step, and a
`<block-grammar>` tag in the generation prompt carrying each block's two bands for R5.2
traceability. `verify:archetypes` asserts that what is stored is what the scaffold offers —
"written correctly, dropped on the way out" is the failure this codebase has hit most often.

**Inclusion is decided on presence, using the identical rule the sections use.** Density is
carried as descriptive evidence and explicitly not significance-tested: ranking by a mean
nobody tested, printed in the same typeface as a tested number, is how the `quality_score`
banding mistake happened.

> **Two block types earn nothing in any category, and one of them is a finding about our
> detector rather than about skills.** `stance` measures −6 in `review` and is a genuine
> pruning candidate (Doc 6 §7 anticipates this). `anti-example` measures −5, which
> contradicts Doc 6 §2 head-on — it is named there as the rarest and most valuable type.
>
> **Neither is published as guidance, deliberately.** Negative lift becomes an anti-pattern
> for free everywhere else in the miner, and it would here too. But the `anti-example`
> detector fires on markers — ❌, "common mistakes", "what not to do" — and long-tail skills
> reach for that punctuation constantly while a vendor writing formal documentation expresses
> the same knowledge as prose and matches nothing. So the negative lift may be measuring
> **house style rather than the presence of failure-mode knowledge**.
>
> A negative claim also deserves a higher bar than a positive one: "the strong band writes
> these" invites an author to add something, while "the strong band writes fewer of these"
> invites them to delete knowledge, and being wrong costs more. Every measurement is stored
> in `stats.measuredBlocks`, so a better detector — or fifty skills read by hand — can
> revisit it. `verify:archetypes` **refuses any published block with non-positive lift**, so
> the reasoning cannot be undone by a sort order changing.

A miner bump was required rather than optional: `mineAndStore` skips on an unchanged skeleton
*and* a matching miner version, so 3.0.0's blocks would otherwise have reached exactly zero
archetypes, silently. Same trap 2.1.0's attribution walked into.


### The block library, and a ranking that had to be read to be found wrong

`src/server/analytics/block-library.ts` · `src/server/builder/deviation.ts`
`pnpm blocks --library <category>` · `pnpm verify:blocks` (55 checks, free)

The archetype now says *a curated review skill carries a decision rule, 75% against 55%*. An
author's next question is immediate and the platform could not answer it: **what does a good
one look like?** The answer was eight exemplar skills, which asks somebody to open eight
documents and find the relevant passage in each. The blocks table already knew where every
passage in the corpus was.

**A row is a coordinate, so a fragment is resolved and never stored.** `skill_blocks` holds
`[startChar, endChar)` and no text — that decision was made for this feature and it pays off
three ways: the licence gate applies at the moment of *reading* rather than a snapshot of what
it said months ago, a withdrawn skill stops being quotable immediately (R7.5) rather than
living on in a stored copy, and an edited skill cannot be misquoted because the offsets belong
to one `content_hash`.

**Ranked on source trust, never on the quality score** — the same reversal the miner had to
make, importing `CURATED_LIST` rather than copying it. The library shows fragments from the
band that produced the guidance, or the guidance and its examples are two different claims.

> **The first ranking was wrong in three ways at once, and only running it showed that.**
> It sorted `quality_score desc, word_count desc`, which looked entirely reasonable.
>
> **Quality score is degenerate here, so it sorted nothing.** Every fragment came back
> `q100` — exactly what the archetype section above documents about a score bounded at 100
> with thousands tied there. **So `word_count desc` decided**, and it means *longest under
> the ceiling*: the results were 219, 216, 200 and 199 words against a 220-word cap. The
> library was reliably returning the biggest passage that fit. **And unquotable fragments
> crowded out readable ones** — reference pointers came back three-of-four withheld, all
> from one repository whose licence is `unresolved`: a panel of four items with one usable.
>
> It now sorts quotable-first, then curated, then **distance from the median length of that
> type in that band**, computed in the same query because a typical guardrail and a typical
> procedure are different lengths. Plus `distinct on (src.id)` — **one fragment per source**,
> which is R3.4's distinct-structures argument at fragment scale.
>
> None of this was a bug a type checker or a row count could have caught. It needed the
> output printed and read, which is why `pnpm blocks --library` exists at all.

**What it refuses to show, each refusal load-bearing:** unlicensed content (`metadata_only`
and `unresolved` are analysed and never copied — the row still exists, and the reader gets
attribution and a link to origin instead of text); more than one fragment per source;
near-duplicate variants; and fragments below 12 or above 220 words, because a four-word
guardrail teaches nothing and a 400-word one is a section wearing a block's clothes.

**No copy button, deliberately.** A library that pastes a stranger's paragraph into a draft
manufactures the homogenisation Doc 2's risk register warns about *and* launders an
attribution-required fragment into a document with no attribution. These are examples to read.

**Fragments never reach the generation prompt either, and that is structural.** It would be
one line to add them as few-shot examples. Most of this corpus is `attribution_required`, and
a model handed attributed prose can reproduce it into a document carrying no attribution — the
platform laundering a licence obligation through its own builder, on the exact axis the
download route returns 451 to protect. What travels instead is **our own vocabulary about the
corpus**: a block type's label, blurb and two prevalence numbers. `Scaffold` has no fragment
field, so widening the type is the change to refuse.

#### The offset base is the one thing that must be exactly right

> **The first draft of the library had this bug in waiting.** It carried a three-line local
> frontmatter stripper instead of calling `splitFrontmatter`. The offsets index the body the
> extractor segmented, so a reader using a different base returns a passage shifted by the
> length of the YAML block — **plausible text, wrongly attributed to a named repository**.
> Nothing about that looks broken from the outside, and it would have been a **second source
> of truth for where a body starts**, which is the same mistake as a checker holding its own
> copy of the rule it checks.
>
> So `verify:blocks` does not compare the library against a hand-written expectation. It
> re-extracts the same bundle with the real extractor and requires the library's text to be
> **that block's own slice, character for character** — then reads the same offsets against
> the un-split file and requires the two to *differ*, so the check is proven able to fail. A
> skill with no frontmatter is skipped rather than asserted, because a fixture that cannot
> reproduce the bug proves nothing.

#### R4.3, closed at block granularity

`blockDeviations` runs the draft through **`extractStructure` itself**, by handing it a
synthetic one-file bundle. Nothing reimplements segmentation, and that is the whole reason the
comparison means anything: a second, lighter detector would drift, and every drift would
surface as a deviation the author cannot act on — the archetype saying 75% of curated skills
carry a decision rule, the draft genuinely carrying one, and a different parser reporting it
missing. Same argument R6.1 makes for publish-back calling the real validator.

The panel is written so it cannot become a checklist. A **missing** block states the evidence
and stops; nothing is blocked, because a skill with no decisions to make should not carry a
decision rule and no measurement here knows which case the author is in. An **extra** block
type carries no judgement at all — two types measure negative lift and the miner deliberately
refuses to publish that, so calling an unlisted type a problem here would smuggle in through
the builder the claim `archetype.ts` declines to make. **Density is reported and never
scored**, because inclusion was decided on presence and a builder demanding 4.3 procedures
would be enforcing an untested mean.

> Two checks that matter more than the rest: re-measuring a *stored* corpus document must find
> the block types already stored for it — not a tautology, because the stored rows came from a
> batch run weeks ago and this runs the extractor now, so segmentation moving without a
> re-extract shows up here as a disagreement. And `notMeasured` is distinguished from "nothing
> missing", because an archetype with no blocks would otherwise read as a fully conformant
> draft.


### A skill's own parameters, and the rule that stays prose until somebody confirms it (Doc 7 RD.1–RD.3, step P4)

`src/lib/parameters.ts` · `src/server/builder/parameters.ts` · `components/builder/parameters-panel.tsx`
migration 0050 · `pnpm verify:parameters` (61 checks, free) · Settings → Models → **Parameters**

`decision-rule` is the strongest discriminating block in the corpus — 10 of 13 categories at +22 —
and the designer knew nothing about what a rule branched on. Now a draft can declare its
**parameters** (name, kind, values), a decision-rule block can carry a **structure** beside its
prose (`conditions → action`), and two things are derived from that: **coverage** of the case
space and **consistency** between rules on the same parameter. Doc 7 §3 has the argument; this
records what was decided while building it.

#### The document stays the artefact, so everything renders to markdown

No new frontmatter key, no rule engine, nothing the agent has to know about. The Parameters table
reaches the body as an ordinary `glossary` block written through `setDraftBlocks`, so
`skill_drafts.body` keeps its single writer — `verify:draft-blocks` stayed at 62/62 with the
scan that asserts it. Structure → prose is a **deterministic render** (a table for two or more
rules, a sentence for one; byte-stable across calls). Prose → structure is a model *candidate*
the author confirms. An author who edits a rendered table detaches it: the block is marked
*structure out of date* and never re-rendered underneath them — the same rule shared blocks hold.

#### Two departures from the spec, both about where a candidate lives

**Parameter and rule candidates are not interview candidates.** The directive said reuse the
Interview accept path. An interview candidate is *a block to append*; a parameter candidate is a
`draft_parameters` row with a `decision`, and a rule candidate is `draft_blocks.rule` with
`confirmed: false` on the block it describes. Filing them in `interview_candidates` would have
needed a third origin column and a fake session — the fake-source shape `skill_drafts` warns
about. Same mechanics (pending → accepted or rejected, rejected kept), separate rows.

**Confirming a rule writes `rule` and never `text`, directly.** Not through `setDraftBlocks`:
the text does not change, so the body does not change, and a revision whose diff is empty is
noise in the history. `verify:parameters` asserts those direct sets touch `rule` alone. Only a
`decision-rule` block keeps a `rule`; retyping drops it.

#### Coverage says which zero it is, and gates nothing

`0 / 0` is not 0%. An `enum` with no declared values is **not measurable**, and the panel says so
rather than showing an empty bar. An explicit *otherwise* row counts as covered — a skill may
leave a case to judgment and say so. Uncovered cases are listed one by one with **"add a rule
here"**, which inserts an empty structured rule and never pastes anybody's action. Nothing here
reaches the publish gate: the suite scans `publish.ts` for any reference to parameters or coverage
and finds none, and a draft's status stays `ready` when its coverage drops.

Detection is one Flash-Lite call per decision-rule block, behind a button, metered as `builder`
against the workspace cap; consistency is one call per pair of rules sharing a parameter, capped
at `MAX_CONSISTENCY_PAIRS`. Model task `parameters`, default `gemini-2.5-flash-lite`, resolved
once per invocation like every other task.

> **This makes migration 0050 a hard dependency of the draft page.** `getDraftBlocks` selects
> `rule`, so `/build/[id]`, `verify:shared` and `verify:interview` fail with `column "rule" does
> not exist` until it is applied. Migration-before-code, loud rather than silent — the note 0029,
> 0034, 0035 and 0043 each carry.

### Tool references are counted before a vocabulary is written (Doc 7 RD.6 measurement, step P0)

`src/lib/tool-refs.ts` · `src/server/analytics/tools-run.ts` · extractor **2.1.0** · migration 0050
`pnpm structures --probe 400 --tools [--samples npx]` · `pnpm structures --tools` · `pnpm verify:tool-refs` (44 checks, free)

Skills name `gh`, `kubectl`, `psql` everywhere and the registry can filter on none of them. Doc 7
§4 says the tool vocabulary is **seeded from a corpus count, not from memory** — the way
`SEED_REPOS` are verified against the GitHub API rather than typed from recollection — and this
step is the count. Three sources, one confident: the first token of each command line in a shell
fence; `allowed-tools` from Claude Code's frontmatter (`Bash(git:*)` names two tools); and inline
code in prose, which **confirms** a tool the document invokes elsewhere and does not establish
one on its own, because `` `SKILL.md` `` and `` `kubectl` `` are indistinguishable by shape.

Stored on `skill_structures` as `tool_refs jsonb` (token → count), `allowed_tools`,
`version_pins`. Candidate tokens, deliberately: a token no vocabulary names is a fact about the
corpus and is counted as *unrecognised*, the way the unclassified block share is.

#### The probe writes nothing, and it found three faults in three runs

`pnpm structures --probe N --tools` runs the real extractor over a random sample of real bundles
and prints the table, sorted by **distinct repositories** so a generator shipping eighteen skills
that call one CLI cannot head it. It exists for the reason `structures --probe` did: a fixture
proves a rule *can* fire, only real text shows what it fires on.

> **First run: `bash` at 585 references across 131 skills, top of the table.** A block's text
> runs from the opening fence to the closing one, and the normaliser strips leading backticks —
> so the first "command" of every bash fence was its language tag. **Second run:** `eof`, `import`
> and `def` in the code column (heredoc bodies from `python3 - <<EOF`), and `post`, `get`, `const`,
> `await` in the prose column (snippets in backticks read as commands). **Third run:** the top
> version pins were `workflow 1` and `pattern 3` — numbered headings — then `But 4` and `Read 2`.
>
> Each fix is a rule with the probe's number beside it, and `verify:tool-refs` reproduces the
> naive reading first — asserts that the fence line *does* read as `bash`, that `EOF` *does* read
> as a command — before asserting the detector declines. A fixture that no longer reproduces the
> bug is a fixture that passes for the wrong reason.

**What it measured** (400 bundles): 53% of skills reference a tool, 9% declare `allowed-tools`,
47% carry a decision rule at 3.2 per skill. Per category, from stored block counts over the whole
labelled corpus, **38–55% of skills carry a decision rule** — Part A's input exists in half of
every category. `structures --tools` reads that half at the newest extractor version that *has*
rows and says which, because a bumped version must not look like data loss.

Two stated limits, carried into P1: a bare three-word command alone in backticks (`gh pr
create`) does not count without the tool in a fence or `allowed-tools` — an English phrase in
backticks is argv-shaped too, so a command needs an *argument* to stand alone; and version pins
are the roughest detector, read from prose only, mid-sentence, capitalised or confirmed. P5 reads
their noise before building on them.

> **The extractor is 2.1.0 and the re-extract has not run.** No block rule changed, so every
> stored span stays valid — but the version string is the only selector a re-extract has, and
> the three new columns are empty on every 2.0.0 row. Until `pnpm structures --extract 500
> --drain` finishes (~2.5 hours, free, in your own shell), `db:audit`, `archetypes --mine-all`,
> `verify:blocks` and `verify:tokens` all report the corpus as unextracted, and they are right
> to. The stored `--tools` table is empty until then; the probe answers now.

### Expertise capture: the value is the denominator (RK.8, plan step E7) — Team

`src/lib/campaigns.ts` · `src/server/campaigns/run.ts` · `/capture` · migration 0049
`pnpm verify:campaigns` (9 pure checks + a stored probe, free)

*"Before a senior engineer rotates off, run Interview and Distill against their domain in
facilitated sessions; output is a reviewed skill portfolio."* Organisational-memory insurance.

**This step was deferred and then asked for, and the concern that deferred it stands**: its shape
is a guess until a real programme runs against it. It is recorded in `specs/plan.md` rather than
argued twice.

#### "Nothing new underneath it" is the specification, not a caveat

Interview elicits what somebody has not written down. Distill takes it from work that already
happened. Both produce typed candidate blocks through one accept path. A campaign **captures
nothing** — `verify:campaigns` asserts the module reaches no model, no embedder and no block
writer at all.

What it adds is the thing neither has: an answer to *are we finished*.

#### A progress bar needs a denominator, and the denominator is a human artefact

The tempting build is a bag of drafts with a count. That counts what happened and cannot say
whether it was enough — a rate with no sample size, which this codebase marks as thin everywhere
else it appears.

So a campaign is a **named list of topics**, written before the interviews start by whoever knows
what is at risk. *Incident escalation. The Redis failover runbook. The data-retention rules.*
Progress is topics captured against topics named.

That list is also the artefact with value independent of the software. **No tool does the hard
part** — deciding what one person knows that nobody else does — and the empty state asks for the
list rather than offering a button that starts work.

#### Derived, so it cannot drift

There is no counter column and no job maintaining one. A topic's state comes from its draft: no
draft is *not started*, a draft is *in progress*, a published draft is *captured*. A stored status
goes stale the first time somebody publishes without coming back to tick a box — which is the
normal way work happens, and it drifts in the flattering direction, because nobody notices a
progress bar that is too high.

`verify:campaigns` proves it the only way that means anything: it publishes a draft **by writing
`published_skill_id` directly**, telling the campaign nothing, and requires the campaign to report
50%. A stored counter would still read zero.

> **An empty campaign reports no share, not 0%.** *Nothing captured* and *nothing asked for* are
> the same zero and opposite meanings, and a bar at zero on an unscoped programme reads as failure
> where it should read as unstarted. The endorsement card and `archetypes --blocks` each had to
> learn this; `capturedShare` returns `null` and the panel says "not scoped yet".

> **Deleting a draft nulls the topic's link rather than deleting the topic.** A cascade would
> shrink the denominator, and a programme would report itself **more complete** because somebody
> tidied up. Same reason an accepted interview candidate keeps its row when the block it became is
> deleted.

#### Effort beside outcome, never averaged into it

Interview sessions, distill runs and accepted suggestions are derived from the campaign's drafts
and shown next to the topic counts. *Twelve interviews* is a fact about work; *four of nine
captured* is a fact about the result. One number blending them answers neither — the argument
that keeps lift and telemetry separable on an archetype page.

#### Doc 6 says Enterprise, and there is no Enterprise

`PLANS` has three tiers and `team` is the top. Adding a fourth is a pricing decision with a page
and a contract behind it, not a code change — so `capture-campaigns` sits on the highest tier that
exists and the mismatch is written into `plans.ts` rather than resolved by inventing a plan nobody
has agreed to sell.

### Notifications: no notification table, and the events name the wrong thing (R8.7, plan step F5)

`src/lib/watch.ts` · `src/server/notifications/watch.ts` · migration 0048
Watch button on a skill page · the feed on `/dashboard` · `pnpm verify:watch` (free)

The last step of the plan. *"Watch a skill or a category; be told when a version changes, a
takedown lands or a lifecycle state moves."* The plan's own note is the design: **every one of
those already exists as an `events` row**, so this is not an event system — it is a subscription,
a query and a surface.

#### Derived on read, so there is nothing to re-run

The obvious build materialises a notification row per watcher per event behind a cursor job.
That is a job that can fail silently, a dedup rule, and a second copy of what `events` already
holds — three recorded failure shapes in one feature.

A watch stores **what you follow and when you last looked**; the feed is a query since that
timestamp. Correct by construction, and a watch created today can show last month, because the
events were never the missing part. Read state is one column: `last_seen_at`. There is no
`notifications` table and `verify:watch` asserts there is not.

#### The events name a version. The watcher names a skill.

Measured on the live table before any code was written — which is the only reason it was caught:

```
108,074  skill_version.indexed      · skill_versions
 51,207  skill_version.created      · skill_versions
  2,804  skill_version.quarantined  · skill_versions
    404  licence.reresolved         · skill_version     ← singular
```

Every kind that matters carries a **version id** in `subject_id`. A feed matching
`subject_id = <skill>` returns almost nothing and looks like a working feature over a quiet
corpus — a confident empty answer, which is the failure this codebase finds most often.

And one kind spells its subject type differently: 404 `licence.reresolved` rows say
`skill_version` where everything else says `skill_versions`. Matching one spelling drops them
silently, and a licence re-resolution is exactly what a watcher wants — it is the event that
turns an undownloadable skill into a downloadable one. **Fixed forward in `sync.ts`; both
spellings accepted for the history.**

> **The first query took over twenty minutes, and that is why it was probed.** `join skills s on
> (subject is the skill) or (subject is one of its versions)` — Postgres cannot use an index for
> either branch of an `or` across two join conditions, so it degraded to a scan of 185,000 events
> against 50,000 skills. It blew a five-minute timeout, was left running in the background, and
> eventually returned **111,207 joinable notifiable events** — which is both the confirmation
> that the join is *correct* and the measure of how unusable it was. Same class as E2's
> accidental cross-product, found the same way.
>
> The fix is not one clever query but **two shapes, because the two watches want opposite
> drivers**: a skill watch knows its subject and drives from `events_subject_idx`; a category
> watch has thousands of skills and drives from `events_at_idx`, because the window since you
> last looked is small where the category is not. Measured: **63 ms** and **1.67 s**.

> **And `sql<T>` lied again, in the same codebase that has a section about it.** `FeedRow.at` was
> annotated `Date`; `db.execute` with a raw template applies no parser, so the driver returned a
> string and the dedup key called `.toISOString()` on it. E1's `linkCheckSummary` did exactly
> this with `min(checked_at)` and CLAUDE.md already recorded the rule — *a `sql<T>` annotation is
> a claim about a value, not a conversion of it.* Knowing the rule was not enough; running the
> code was. Typed honestly now, converted once at the boundary.

#### An allow-list, because the loudest events are the least interesting

`skill_version.created` is 51,207 rows and fires when bytes change upstream *before validation
has decided anything* — `indexed` and `quarantined` are the answers, and reporting the question
as well doubles the feed. `structures.extracted` and `taxonomy.classified` are derived-data
passes. All three are true, all three are about your skill, and all three are noise.

A feed that reports every pass is one people mute, and then the quarantine in amongst it is
missed. Ten kinds are notifiable; the suite asserts the three loudest are not.

#### Smaller decisions

- **A new watch sees thirty days of history.** A feed that is empty on the day you subscribe
  teaches people it does not work — and the events were always there, so hiding them would be
  pretending the feature started when you pressed the button.
- **A watch is keyed on the person, not the workspace.** Two colleagues watching different skills
  is the normal case, and an org-keyed row would let one unsubscribe the other.
- **A category watch uses the servable-category rule** the registry applies, not every
  assignment. Notifying somebody about a skill that is only *maybe* in their category is how a
  feed earns a mute.
- **The empty state says which empty it is** — *you watch nothing* and *nothing happened* are the
  same list and opposite conclusions.

#### What is deliberately not built: sending anything

There is no email. R8.7 says *be told*, and a feed on a page is the weaker reading — but delivery
needs an unsubscribe path, bounce handling and a digest cadence, none of which exist, and
`MAIL_TRANSPORT` is pinned to `console` locally so a laptop cannot quietly email people. Shipping
a sender without those is how a platform earns a spam complaint on behalf of its users.

The watermark makes it a small step when it comes: a digest is *the feed since `last_seen_at`*,
which is the function that already exists.

### The public API serves metadata, and that is what makes bulk access lawful (R8.6 / R3.7 / R8.3, plan step F4)

`src/lib/api.ts` · `src/server/api/public.ts` · `/api/v1/…` · `pnpm verify:api` (23 checks, free)

Three requirements, one surface, no migration:

| | | |
|---|---|---|
| **R8.6** | `GET /api/v1/skills` and `/skills/{slug}` | the read half of what MCP already serves, over HTTP |
| **R3.7** | `GET /api/v1/dataset` | the researcher offer Doc 1 makes, cursor-paged |
| **R8.3** | `GET /api/v1/skills/{slug}/resolve` | version pinning over the content hash |

Every shape calls the same `src/server` function a page calls — RM.2's rule, written for MCP and
holding verbatim here. A lighter reimplementation would be a second definition of *servable*, and
the second drifts on licence gating and takedowns, where drift is a legal problem rather than a
bug.

#### Metadata, never bodies — the constraint is the feature

96% of this corpus is `attribution_required` and some is `metadata_only`, which is precisely the
posture meaning *we may say it exists, name it, describe it and link to it, and may not hand over
the bytes*. **That is the exact shape of a metadata API.**

So a bulk endpoint with bodies would be lawful for none of the corpus, and one without them is
lawful for all of it — including the skills nobody may download. The download route keeps its
451s and stays the only path to bytes. `verify:api` reads real records back and asserts no field
is long enough to be a body, and scans every route for any route to a bundle at all.

**The verdicts come back as counts, not findings.** A finding can name the line of somebody's
skill where a credential sits; a bulk-readable index of *where the secrets are* is a worse thing
to publish than the score it produced. The page shows them to a reader who came for one skill.

#### Two licences, because there are two

The **skills** are their authors' — carried per record as `licence` and `redistribution`. The
**derived analysis** is ours: verdicts, quality scores, categories, archetypes. Doc 1 licenses
archetype snapshots CC BY-SA and the same terms are the honest offer for the rest.

Both are stamped on every envelope, which is not decoration: a researcher publishing a paper needs
to know which half they may redistribute, and a single `licence` field would be wrong for one of
them whichever value it held.

#### Smaller decisions

- **A withdrawn skill is 410, not 404.** R8.4 wants citations to keep resolving, and *"it was here
  and it is not any more"* is a fact a reader can act on where a silent 404 is not.
- **A near-duplicate resolves to its canonical entry** and says which name was asked for. An agent
  requesting one of sixty copies should get the one the registry maintains.
- **The dataset is cursor-paged on the slug**, not offset-paged. An offset silently skips or
  repeats rows when the corpus grows underneath a long export, and this corpus grows on a cron.
- **The read limiter is deliberately generous** — 120/min, 3,000/hr — because the API exists so
  people stop scraping pages, and a limit tight enough to annoy sends that traffic straight back
  to the pages it was meant to relieve. Fails open, like the other read scopes.
- **Reads are cacheable for five minutes**, short enough that a takedown propagates within the
  hour, which is the one update that must not linger.

> **The type checker refused a second paging vocabulary, and it was right.** The API first offered
> 10/25/50/100 against the DAL's narrow `5 | 10 | 25`. Matching the registry is not a workaround:
> the API *is* the read half of the registry, so the two behaviours are one behaviour — and a wider
> list would have been silently clamped while the response reported a `pageSize` it had not used.
> `verify:api` asserts the two lists are equal so the copy cannot drift. Bulk has its own endpoint,
> which is what `DATASET_PAGE` is for.

> **The DAL cannot load in a plain node process**, because it resolves a session through
> `next/navigation` — the reason `export.ts` was split into `buildBundle` and `exportSkill`. Its
> imports here are lazy, so the module still loads in a script and **`apiDataset` — pure SQL, and
> the endpoint where a body leak would be worst — stays testable**. The three DAL-backed shapes
> skip with that reason named, covered by the source scan rather than left silently unchecked.

### An agent can create a skill, and cannot publish one (RM.3, plan step F3) — Pro

`src/server/mcp/create.ts` · `create_skill` on `/api/mcp` · `pnpm verify:mcp-create` (20 checks, free)

The `mcp-create-skill` entitlement has been live and unused since A5, waiting on two things: a
paywall to hang it on, and **C1**. A skill written from inside an agent session has to arrive as
typed blocks, or it would be the one authoring path producing a body string and every Compose
surface would need a special case for it. The plan's dependency was right.

#### The boundary is the feature

`create_skill` returns a draft and a URL. **It never publishes.** Publishing runs the validators,
writes corpus rows and makes bytes downloadable — an agent doing that unattended is one prompt
away from putting a stranger's document into a workspace's registry.

That is B2's line, one surface along: **recording and deciding are separate actions**, and a
person does the second. It is not a hedge about capability; it is what makes the feature safe
enough to sell. `verify:mcp-create` asserts it against the *source*, because it is a property of
what the code can reach rather than of what today's data contains.

#### The validator runs on arrival and its findings go back in the response

The same `validateDraftBody` the builder runs (R4.5) — the same analyzers, including the secret
scan and the injection scan. An agent that wrote a credential into a skill learns so **in the tool
result**, where it can fix it in the next turn. The same information reaching a human on Thursday
is too late to be useful to the only party that could have acted on it for free.

#### Writes get their own rate-limit scope, biased the other way

`mcpWrite` is **3 a minute, 10 an hour** against `mcpPaid`'s 600 and 20,000. The read scopes are
loose on purpose — a false refusal there teaches everyone to distrust the limiter — and this
bounds an agent in a loop creating **drafts a human then has to read**. Same inversion
`publicWrite` makes against the MCP reads, for the same reason.

> Adding the scope turned up a small latent hazard: the scope union was written out by hand in two
> signatures, so `mcpWrite` compiled everywhere except the one place that had to know about it. It
> is `keyof RateLimitSettings` now, and a new scope is a type error at every call site rather than
> at none.

#### Two refusals that are answers rather than errors

**An unentitled caller gets a sentence.** `hasEntitlement`, not `require` — a JSON-RPC failure an
agent cannot parse is a dead end, while *"this is on the Pro plan, and a person can author the
same skill at /build"* is something it can relay to whoever asked.

**The tool is listed for everyone**, not hidden from the free tier. A tool that vanishes teaches an
agent the platform cannot do this at all — the same choice the Plans panel makes by showing
features it does not have.

And an **unrecognised block type becomes untyped content**, not a rejected call. `block-types.ts`
keeps `null` a first-class answer so a workbench never refuses to hold a paragraph; refusing a
whole call over one mislabelled block would be Doc 6 §7's over-structuring arriving through a new
door, enforced on a machine that cannot ask what went wrong.

#### Attribution, and the handler that stayed a single constant

An MCP principal carries a token and an organisation, never a user — the token *is* the identity.
`created_by` therefore records whoever created the token, which is a real account (what the
foreign key wants, as F2 learned the hard way) and the truest available statement of who
authorised an agent to write here.

> **The first version built a second MCP handler per request** so the write tool could close over
> the workspace, because the read handler is a module-level constant shared by every caller and
> must never hold one. It worked and was wasteful — and F1 had already opened an async scope
> carrying exactly that principal for the usage recorder. The tool reads it from there, the
> handler stays built once, and there is no mutable global for one workspace's draft to leak
> through.
>
> **And F1's own suite caught F3 breaking F1, in the same session.** `create_skill` was registered
> with a direct `server.registerTool`, so the one tool most worth accounting for was the only one
> not counted. `verify:mcp-usage` asserts the tool **count**, not merely that a wrapper exists —
> a check of the second kind would have stayed green. The wrapper is now `countedRegister`,
> shared by both registrars, and the number in the check is 7.

### Billing webhooks, and the half of the plan's own note that was wrong (RC.4, plan step F2)

`src/lib/billing.ts` · `src/server/billing/webhook.ts` · `src/app/api/billing/webhook/` · migration 0047
`pnpm verify:billing` (13 pure checks + a stored probe, free)

The plan said this was small: *"`setPlan` is already the idempotent write a webhook would call,
and its upsert already tolerates late and duplicate delivery. A route, a signature check and a
provider."*

**True of a duplicate. False of a late one, and that is the whole step.**

Providers retry until they get a 2xx, and retries arrive out of order. A
`customer.subscription.deleted` delayed ninety seconds, landing after the `updated` that upgraded
somebody, **downgrades a paying customer** — and an upsert cannot see it, because in isolation
both writes are equally valid. So every delivery carries the provider's own timestamp, and one
older than the last applied change for that workspace is recorded and refused. `verify:billing`
constructs exactly that sequence and asserts the customer is still on their plan afterwards.

#### No new dependency, on a security-critical path

Verifying a webhook signature is an HMAC over `timestamp.body` and a constant-time compare —
twenty lines of `node:crypto`. Taking a provider SDK to do it means taking its release cadence on
the code that decides whether a stranger may change what customers pay, and hard rule 2 exists so
that trade is made deliberately rather than by reflex. It also keeps the verifier isolated: a
second provider is a second `verifySignature`, not a rewrite.

Four refusals, each a real attack rather than a formality — wrong secret, altered body, replay
outside the window, and **no secret configured at all**, which refuses for the reason
`CRON_SECRET` does: a deployment that forgot to set it is one where an unauthenticated endpoint
changes what people are paying for. The suite signs a genuinely valid delivery first, so the
refusals are proven to be refusals of something the verifier would otherwise accept.

#### An unknown plan must under-act, which is the mirror of an unknown model

`UNKNOWN_MODEL_RATE` is the most expensive rate known, because a budget that silently ignores a
model it cannot price is not a budget. A subscription whose price carries no `metadata.plan` goes
the **other** way: it yields null and the delivery is `ignored`, never `free`. Defaulting to free
would cancel a customer's plan because somebody forgot a field in a dashboard.

The plan is read from the price's own metadata rather than a price-id map in our config, so the
commercial truth lives in one place — beside the money — instead of two, the second of which goes
stale the first time somebody adds a currency or an annual tier.

#### A refusal is still a 200, and every one of them is a row

Providers retry on any non-2xx. Answering 4xx to a delivery that is *correctly* doing nothing —
unknown customer, no rule for that event type, out of order — turns one ignorable event into an
infinite retry loop and eventually a disabled endpoint. **The status code is for the retry policy,
not for us**; the outcome is in the body and in a `billing_events` row. 400 is reserved for a
delivery that did not verify, the only case where retrying is genuinely pointless.

Every outcome is recorded, including the refusals, because an endpoint that only writes when it
succeeds is one where *"we never received it"* and *"we received it and did nothing"* look
identical — the heartbeat's argument, applied to money. The one exception is an **unverified**
delivery: the endpoint is public, so a row per attempt would let a stranger fill the table, and a
row we cannot attribute to a provider is not evidence of anything.

#### What is deliberately not built

**A checkout flow, and a provider account.** This is the receiving half. Choosing and provisioning
a payment provider is a business decision with keys and a dashboard behind it, and until a
checkout exists nothing tells us which workspace a customer id belongs to — so an unrecognised
customer is `unmapped` and an admin links it. That gap is named on the panel rather than left to
be discovered when a payment silently changes nothing.

> **The project's own hook caught this file being written, and it was right.** `no-db-in-api.sh`
> refused the route because its header comment *named* the forbidden modules while promising it
> did not import them. That is the fourth time today a scanner matched prose about a rule instead
> of a breach of it — `verify:relations`, `verify:improve`, `verify:mcp-usage`, and now the hook.
> The comment is reworded; the guard was not worked around.

`setPlan` gained an optional `actorType` so the audit row can say `system` / `billing.webhook`.
A webhook has no user behind it, and recording one would make the log confidently wrong about who
changed a customer's plan — the same reason the public flag intake writes `system` rather than
inventing an account.

### MCP request accounting: a rollup, because a per-request log would answer a question we removed on purpose (RC.3, plan step F1)

`src/server/mcp/usage.ts` · migration 0046 · Settings → **Spend** · `pnpm verify:mcp-usage` (free)

RC.3 has been half done since RC.2 landed. Every *model* call is metered in `llm_usage`, and
**MCP makes no model calls** — so the one surface built for machines had no usage record at all.
What existed was a rate-limit window that resets and a `last_used_at` that overwrites, neither of
which can be read back.

#### The schema decision, and it does not turn on storage

The plan framed it as a trade: one row per request is a real audit trail and a lot of rows; a
daily rollup is cheap and cannot answer *"what did this key do on Tuesday"*. Rows are not what
decided it.

**A per-request log keyed by token would let us reconstruct what a customer searched for.** That
is the precise question `search_queries` was built to be unable to answer — no `org_id` column to
join, a daily-rotating digest instead of an identity, and a comment saying the absence *is* the
safety property. Adding a table that answers it through a side door would undo that decision
without anybody deciding.

So the unit is `(token, day, tool)` and the payload is counts. It answers what the commercial and
support cases actually ask — how much is this key using, which tools, since when — and it cannot
say which skill was fetched at 14:32. **The panel says so**, in the panel, rather than leaving it
to be discovered.

#### Refusals are an `events` row, not a counter

The limiter runs in the route guard, **before** a tool is chosen, so a refusal has nothing to be
counted against and a sentinel in the `tool` column would be a value the next `group by` believes.
It is also the exceptional case and worth detail — which window, which limit, when it lifts — and
detail on the rare thing is what `events` is for. **Successes are countable; failures are
investigable.**

#### AsyncLocalStorage, and here it is actually available

`send-failures.ts` documents at length why it had to settle for a module-level keyed map: Better
Auth owns that route, so there was nowhere to open a scope, and the file carries a warning that
nothing may ever read it from a different request.

**This route is ours.** `guarded` resolves the principal, then wraps `handler(request)` in a real
async scope, and every tool runs inside it. The MCP handler is a module-level constant built once
for all requests, which is why the principal cannot simply be an argument to `registerFreeTools` —
and why the scope is the right shape rather than a convenience.

Recording is wired **once**, by wrapping `registerTool` rather than each of the six handlers, so a
seventh tool cannot be added without it. An error is counted apart from a call: our outage is not
the caller's usage.

> **The recorder swallows its own failures, so the suite writes through it and reads the row
> back.** A reader must not get a 500 because an accounting upsert hit a cold compute — the
> heartbeat's posture — and this project has paid for that once: `recordUsage` swallowed an RLS
> refusal, builder spend went unmetered for a milestone, and the only evidence was a log line
> nobody read. A hand-written insert would prove the table works and nothing about whether the
> function meant to fill it does. The suite also calls the recorder **outside** any scope and
> requires it to write nothing, because a default organisation there would attribute one
> workspace's usage to another.

> **And the scanner read the prose again — third time.** The check for *"the route touches no
> database module"* matched the route's own header comment promising exactly that. `verify:relations`
> hit this hunting `= any(${array})` and `verify:improve` hit it hunting duplicate licence lists.
> Comments are stripped before scanning now. A scanner that reads prose shouts loudest where the
> problem is least.

`mcp_usage` carries the split policy `mcp_tokens` and `llm_usage` already use — SELECT open for
the operator panel, INSERT and UPDATE org-scoped — and **no DELETE policy**, for the reason the
ledger has none: an application that can erase its own usage record has no usage record.

### Shared blocks are synced, never substituted — because live resolution rewrites somebody's document (RK.4, plan step E6)

`src/lib/shared-blocks.ts` · `src/server/builder/shared.ts` · migration 0045
`pnpm verify:shared` (12 pure checks + a stored probe, free) · Team

*"Org-level convention blocks — 'our code style', 'our incident-severity definitions' — defined
once, referenced by many skills, updated in one place with dependent-skill re-validation."* The
enterprise argument is that fifty internal skills become maintainable instead of fifty copies of
drift.

#### This is the one pointer in the codebase that does not resolve live, and the exception is the design

Archetype exemplars, supersession, endorsements, the block library, C6's fork attribution — every
other pointer here resolves live, and this codebase has a section for each explaining why. So the
obvious build is a draft holding a reference, a render reading the current text, and one edit
updating forty documents at once.

**It is wrong here twice over.**

`skill_drafts.body` is a *render of `draft_blocks`* with exactly one writer. A block whose text
lives in another table makes the render depend on that table, so the body and the blocks beside it
can disagree with nothing erroring — the invariant C1 exists to hold.

And worse: live substitution **rewrites somebody's document without their knowledge.** A colleague
edits a convention at 11am, forty drafts change in the middle of sentences their authors wrote,
and no revision history says so. This codebase has a name for that shape and three sections about
the times it happened.

So a transcluded block **carries its own copy and the version it came from**. When the convention
moves, dependents go *behind* rather than changing: the update is offered, the author takes it,
and it lands in the revision history under its own reason like every other change to a draft.
Single source of truth for the **convention**; the author still owns their **document**.

> `verify:shared` asserts exactly that, against the real tables: it pulls a convention into a
> draft, edits the convention, and requires the draft's text to be **byte-identical** afterwards —
> then requires the update to be *offered*, because a mechanism that changes nothing and says
> nothing would be no feature at all. Then it takes the update and checks the revision row says
> `shared`.

#### Published skills are never touched, and RK.4's re-validation is a list

A published skill is bytes at a content hash a verdict covers. Re-resolving a transclusion into it
would change what the verdict describes while the verdict went on claiming to describe it. So
`staleDependents` answers *which published skills came from drafts that are now behind*, and
re-publishing stays the author's deliberate act — the line `reinstateTakedown` already holds about
not restoring content it cannot honestly restore.

#### Smaller decisions worth keeping

- **A no-op edit does not bump the version.** Saving the form unchanged would otherwise put forty
  dependents behind and ask forty people to review a change nobody made, which is the fastest way
  to teach them to ignore the notice.
- **Retired, not deleted.** Deleting would null forty pointers and leave forty authors with a
  block that silently stopped tracking anything and no way to find out why. Same call as a
  withdrawn maintainer standing.
- **Dependents are counted as distinct *drafts*, not blocks.** A draft using one convention twice
  is one dependent, and counting rows would tell an editor that twice as much work depends on
  their change as really does.
- **The name is folded.** Two conventions differing only in capitalisation are one convention and
  a bug — the repository-identity fold, one layer up.
- **An untyped convention is refused**, though `null` stays valid for an author's own prose.
  `block-types.ts` keeps it open so a workbench never refuses to hold a paragraph; a convention is
  not that, because somebody chose to publish it and an untyped one cannot be compared against an
  archetype's grammar.
- **The module never writes `draft_blocks` directly** — a transclusion is an ordinary block with a
  provenance, written by `setDraftBlocks` like everything else. Asserted by source scan, because
  a second writer produces a body that does not match its own blocks with nothing erroring.

### Distill mode: 94% of what looks like the user speaking is `cat` output (RW.5, plan step C4)

`src/lib/distill.ts` · `src/server/distill/run.ts` · migration 0044
`pnpm verify:distill` (23 checks, free) · Pro, gated by A5

C4 is the large step of M5: **reading a Claude Code transcript correctly, deciding what is worth
spending a model call on, and turning a correction into typed candidate blocks through C2b's
accept flow.** Interview mode asks for knowledge the author has not written down; Distill takes it
from work that already happened.

#### The finding that shapes the whole step

A Claude Code transcript is JSONL and the obvious parser is *keep every row whose `type` is
`user` or `assistant`*. Measured against three real transcripts on this machine: **645 of 685
`user` rows carry a `tool_result` block and 40 carry human speech.**

The harness feeds every tool result back as a `user` message, which is right for the protocol and
catastrophic for a distiller — it would attribute the contents of every file read during the
session to the author, as things they said, and then send them to a model. The distinction turned
out to be clean and was **verified rather than assumed**: a `user` row's content is either a
string (a person typed it) or a list of `tool_result` blocks, never mixed, in 685 of 685 rows.

`verify:distill` reproduces the naive reading first — it builds a transcript whose tool output is
a `DATABASE_URL` with a password in it, asserts the naive parser lifts it out as a human turn, and
only then asserts the real one does not.

What else never survives parsing: `thinking` blocks (the model's reasoning is not the author's
knowledge), `tool_use` arguments (file paths, commands, sometimes credentials), and the housekeeping
rows — `mode`, `permission-mode`, `atis-latch`, `ai-title`, `file-history-*` — which outnumber
everything else.

#### Measured on real files, which is the only way to know the reduction is real

| | rows in | kept | dropped | model calls |
|---|---|---|---|---|
| a 9.7 MB working session | 2,821 | 308 turns (38 human) | 645 tool results · 286 thinking · 1,882 housekeeping | **8** |

Eight calls for a session that took a day. That is the cost control working, and it comes from two
filters rather than one: parsing removes 89% of the file, and the correction cue removes most of
what is left.

#### Only a correction is worth a call

The valuable turn is the one where the person pushes back — *no, we never deploy on a Friday* —
because that is knowledge the agent did not have and the author did, which is the definition of
what belongs in a skill. Cues are matched on **human turns only** (the knowledge being captured is
the author's, not the model's) and on **whole words**, because a substring match fires `not` inside
`cannot` and `notation`. Each window carries the turns before it, since *"no, the other one"* means
nothing alone, and overlapping windows are merged rather than sent twice — R6.5's dedup argument
applies to a distiller as much as to a vote.

#### The transcript is never stored, and that is the privacy design

Doc 6 asks for provenance back to the transcript. That is a turn uuid and a timestamp — **a
coordinate into a file only the author holds.** We keep no copy, so the pointer is meaningful to
them and useless to anybody else. It is the `skill_blocks` decision one step further: that table
holds an offset instead of a passage and still needs the bundle; this holds a coordinate into a
document the platform has never seen.

Redaction runs before anything reaches a model, as a **second** line — the first is that tool
output, where the overwhelming majority of secrets in a coding transcript live, never leaves the
parser. What survives is prose a person typed, and people paste keys into prose. The tuning is
asymmetric on purpose: over-redaction costs a candidate block, under-redaction sends a credential
to a third party.

#### The metered half: one candidate table, not two

`src/server/distill/run.ts` · migration 0044 · Settings → Models → **Distill mode**

Candidates land in `interview_candidates` with a `distill_run_id` instead of a session, and
`decideCandidate` resolves the draft from whichever origin matched. **Two candidate tables would
have been two accept paths**, and the second would eventually forget the revision-history note,
the eval case, or R5.4's feedback event.

The alternative — reusing the table as-is by inventing an `interview_session` per distill run —
is the fake-source mistake `skill_drafts` warns about, and it would corrupt *"which technique
produced accepted blocks"*, the one metric that table exists to answer. So `session_id` and
`turn_id` became nullable, `distill_run_id` arrived beside them, and a check constraint holds
**exactly one origin** — `skill_evals`' own precedent, in the same words.

A distilled block gets its own revision reason. `interview` on a distillation would make the two
indistinguishable in the one place an author looks to ask where a paragraph came from.

#### `distill_runs` has no column a transcript could live in

Deliberately, and `verify:distill` asserts it against `information_schema` rather than against
today's data. What the row holds is **counts**: turns read, tool results dropped, corrections
found, corrections sent, redactions. Those are what make a run legible after the fact — an
operator asking why one import produced three candidates and another forty answers it from the
row — and `tool_results_dropped` is the number that would move first if the parser ever started
reading file contents as speech.

The output schema has no field a transcript excerpt could be returned in, which is the half of
*patterns, not verbatim text* that a prompt cannot enforce on its own. The model is asked for the
**rule** behind a correction, in the author's voice, and told that returning nothing is a correct
and common answer — most corrections are about one filename.

#### Two budget decisions that go the opposite way from their neighbours

**Checked once before the run, then again per call.** Everywhere else the check is per call,
because everywhere else a call is the unit of work. A run of forty calls checking only itself
would blow RC.2's one-call overshoot bound forty times over — and one that refused mid-run and
discarded what it had produced would lose an author's work to protect a cap. So the loop **stops
and keeps**, and the report says how far it got.

**Flash-Lite, not Sonnet**, against the pattern set by `builder` and `interview`. The excerpt is
short, the instruction is narrow, and *returning nothing* is the commonest correct answer — that
is a classification-shaped job, which is where the small model is genuinely right, and the author
sees every candidate before it reaches the draft.

> **A run that stopped early used to claim it had not.** `windows_sent` was written as
> `sending.length` before the loop ran, so a run cut short by the budget would report forty calls
> it never made — in the one column an operator would use to explain a bill. Corrected to the real
> count after the loop.

Still deferred, in the plan's own order: **documents**, then **diff-to-skill**. JSONL first was
the right call — it is the input with a shape worth discovering, and discovering it is what the
first half was.

### Improve an existing skill, and the fork that must not launder a licence (R5.6, plan step C6)

`src/lib/improve.ts` · `src/lib/licence.ts` · `src/server/builder/improve.ts` · migration 0043
`/build` → Improve an existing skill · `pnpm verify:improve` (28 checks, free)

The first entry into the builder that does not begin with a blank page, and the first step that
serves somebody who did not author here. Once a document is typed blocks in a draft, **every**
Compose surface applies to it unchanged — deviation marks (R4.3), the block library (RW.3), the
scope analyser (C5), the eval lab (D1). Nothing here re-implements any of them, which is C1's
keystone paying off exactly as the plan said it would.

So the step is almost entirely import, and import is almost entirely **licence**.

#### Three sources, and only one is free of the hard question

| | |
|---|---|
| **owned** | published from your own workspace. Your bytes, your workspace, nothing to ask. |
| **uploaded** | a document you hand us. Yours by assertion; we cannot check and do not pretend to. |
| **forked** | somebody else's registry skill. This is the one with teeth. |

**Which one it is is decided by the data, never by the caller.** The org id on the skill row is
the fact. A parameter saying "this is mine" would be a parameter that could declare away the
licence gate, which is the whole mechanism.

#### A fork is the block library's refusal at whole-document scale

`block-library.ts` has no copy button because pasting a stranger's paragraph *"launders an
attribution-required fragment into a document with no attribution"*. A fork is that for a whole
document, and the temptation is larger because the result looks like ordinary authoring. Three
rules carry it:

1. **Only a redistributable posture may be forked.** `metadata_only` and `unresolved` have no
   grant and no stored bytes — the same gate the download route returns 451 for.
2. **The obligation is frozen onto the draft**, not resolved by a join. `takedowns` duplicates
   `(source_url, skill_path)` out of its join columns for precisely this reason: the record has to
   work when the rows it was recorded against are gone. A licence obligation that vanishes because
   an upstream row was deleted is the failure mode with legal consequences. The upstream's
   *display* — current name, whether it has since been withdrawn — still resolves live, like an
   archetype exemplar. **Frozen obligation, live presentation.**
3. **Publishing a fork inherits the upstream posture, licence and licence source.** The pre-C6
   path wrote `redistribution: "mirror_allowed"`, `licenseSource: "authored"`, `licenseSpdx: null`
   unconditionally — over an imported Apache-2.0 skill that would have been the platform stripping
   an obligation through its own builder.

> **The third rule cost nothing to enforce and that is the point.** `exportSkill` already writes
> `ATTRIBUTION.txt` into the archive for an `attribution_required` posture. Carrying the posture
> forward therefore carries the credit into every download of the fork, with no new code — the
> requirement satisfied by propagating a fact rather than by remembering to add a feature.
>
> The upstream's own `license_source` is carried **verbatim** rather than gaining an `inherited`
> enum value. The licence really was determined that way, by that step of the six-step chain, and
> a new value would claim a different provenance for the same fact.

#### A draft learned to hold files, which closed the half of C5 that could not be built

`draft_resources`. A draft was one document, which was right while every draft started from a
scaffold — but a real skill is a **bundle**, and importing one while keeping only the marker would
silently discard the half the archetype rewards most: the miner measures *links to its own bundled
files* at +23 and *offloads detail into `references/`* at +12 to +26.

It is also where RW.11's actuator writes. C5 could compute which blocks should move into
`references/` and had nowhere to put them; `offloadBlockToReference` now moves one and leaves a
`reference-pointer` **in its place** rather than appending it — a reader who arrives where the
detail used to be should find the signpost there, not three sections later. It goes through
`setDraftBlocks`, so the body keeps its single writer and the move lands in the revision history,
which is why C1b made restore append rather than truncate.

**Text in a column, not bytes in a bucket.** Object storage is for *published* bundles,
content-addressed at the hash a verdict covers. A draft is mutable, private, measured in
kilobytes, and deleted when its author deletes it — putting it in R2 would buy an orphaned-object
lifecycle and a second home for tenant data in exchange for nothing. `MAX_RESOURCE_BYTES` keeps
that trade honest, and binary is refused rather than mangled: `looksBinary` reads the bytes,
because an extension is a guess about a filename and a NUL byte is a fact.

> A path cannot climb out of the bundle. An uploaded archive is a far more direct route to
> directory traversal than the git symlinks the connector already declines to follow, and
> `safeResourcePath` refuses `..`, absolute paths, dotfiles and NULs, folding backslashes so a
> Windows archive cannot smuggle one past.

#### One definition of what may be copied, and the scan that found five more

`REDISTRIBUTABLE` now lives in `src/lib/licence.ts` and everything imports it. Before this step it
had **three** independent definitions — `mayMirror` in storage, `QUOTABLE` in the block library,
and one written for this importer.

Three copies of a rule about *what may legally be copied* is worse than three copies of most
things: they cannot drift in a way a type checker notices, they are read by people making
decisions about somebody else's rights, and the day one gains a posture the others do not is the
day the platform copies bytes one of its own modules would have refused.

> **`verify:improve` scans the tree for a fourth, and on its first run found four more I did not
> know about** — `SERVABLE` in the download card, `SERVABLE` in `dal/stats.ts` (whose own comment
> admitted *"Mirrors `skills/export.ts`"*), `EXPORTABLE` in the export path, and a literal in
> `verify:blocks`. Six of one rule, in a codebase that already had a section about this failure.
>
> **And the scanner's first version was too crude, for the second time in this repo.** It flagged
> `POSTURE_KEYS` in the licence badge and `POSTURES` in the MCP tool schema — the **four**-posture
> display vocabulary, a different rule entirely. Two of six hits were false, exactly as the
> `= any(${array})` scanner's first version matched the *warnings* about the trap it hunts. A pair
> followed shortly by `metadata_only` is a vocabulary, not a copy.

#### Smaller decisions worth keeping

- **`purpose` is not filled from the imported description.** It is what somebody typed into the
  builder, and nobody typed anything here — putting the upstream author's words in this author's
  mouth on the one field R6.2 reads as intent would corrupt the loop's input.
- **A binary asset in a corpus bundle is skipped; one in an upload is refused.** The uploader chose
  their files and deserves to be told; somebody forking a skill did not choose the image inside it.
- **The importer never writes `skill_drafts.body`** — it goes through `importDraftBody`, the same
  path a generation takes. Asserted here as well as in `verify:draft-blocks`, because a module
  holding a whole document is the most tempting place in the codebase to add a second writer.
- **The panel says what forking costs before the button, not after.** Somebody who would not
  accept the licence terms should find out while stopping is still free.

> **This makes migration 0043 a hard dependency of the builder.** `getDraft` selects
> `import_source`, so `verify:publish` fails with *column "import_source" does not exist* until it
> is applied. Migration-before-code is the normal order and a loud failure is the right way round
> — the same note 0029, 0034 and 0035 each carry — but it is worth knowing before wondering why a
> green suite turned red.

### The scope analyser, and the confound that would have told half the corpus to cut itself up (RW.10 / RW.11, plan step C5)

`src/lib/scope.ts` · `src/server/analytics/scope.ts` · migration 0042
`pnpm scope --status | --run N | --skill <slug>` · `pnpm verify:scope` (35 checks, free)

Two questions about a document's shape that no existing surface asks. The analyzers ask whether a
skill is well-formed, the archetype whether its structure matches what the corpus rewards, A3 what
it costs to load. None of them asks *is this one skill or three*, or *does this detail belong in
the body*.

**RW.10** clusters a skill's blocks and looks for a seam. **RW.11** proposes moving long,
peripheral blocks into `references/` behind a pointer — progressive disclosure, which the miner
already measures at +12 to +26 lift.

#### Cluster any document's blocks and you get two clusters. The question is what they are clusters *of*

Guardrails read like other guardrails and procedures read like other procedures, so the strongest
seam in a bag of block embeddings is frequently **block type** rather than subject. A split along
that seam is not *this is two skills*, it is *this skill has rules and steps*, which is true of
nearly every good skill in the corpus — and shipping it as a decomposition proposal would have
told a large part of the registry to cut itself in half.

`typeAlignment` measures each cluster's dominant-type share. Above `MAX_TYPE_PURITY` the verdict is
**`type-aligned`** and no split is proposed. `verify:scope` builds that exact document — same
geometry as a real two-subject one, but the groups *are* the types — **asserts the naive reading
still calls it a confident split**, and only then asserts the analyser refuses it. Reproduce the
failure, then assert the fix.

The mirror image needed the same care: 59% of corpus blocks carry no type, and counting
*unclassified* as a type would have made purity high everywhere and refused every real finding.
`typeAlignment` returns null when either half is mostly untyped, and that document is judged on
separation alone.

#### The verdict has to be reproducible, so the clustering cannot be random

Two-means from a random seed gives a different answer on a re-run of the same document — so *is
this two skills* would depend on when you asked, and a stored verdict would be unreproducible for
R7.2. The seeds are the **two most dissimilar blocks**, which is deterministic and, on a document
that genuinely has two subjects, almost always one from each. The suite runs the same input twice
and requires an identical report.

#### `MIN_SPLIT_SEPARATION` is a guess, and the code says so

0.22, derived from the only adjacent measurement there is — B3 put genuinely different skill
summaries 0.3–0.5 apart in the A6 index, and block text should be narrower because every passage
in one document shares its vocabulary. Conservative on purpose: a false negative here is invisible
and a false positive asks an author to do real work for nothing.

**Calibrating it is the reason the plan says to run this over corpus skills before it reaches a
draft.** So there is a CLI and a stored verdict and **no builder panel yet**, which is a decision
rather than an omission. Until the candidates have been read and the number moved,
`split-candidate` is a prompt to read the document rather than a finding about it.

#### The maths is a leaf module, and that is what makes it checkable

Every function is pure — vectors in, numbers out, no imports. So the suite constructs a document
that is obviously two subjects, one that is obviously one, and one whose split is an artefact, and
asserts the metric separates them **with no corpus, no API key and no fixture that might have
stopped reproducing its case**. 27 of the 35 checks need neither database nor network — the rest
execute the two raw queries and read the stored rows. Same reason `quality.ts` and `tokens.ts` are
leaves.

#### Disclosure refuses to hollow out a document

Three conditions, and dropping any one breaks it:

- **the body is already over the validator's own `DISCLOSURE_HINT_BYTES`.** Imported, never a
  second opinion about "too big" — a restructurer with its own threshold eventually tells an
  author their skill is fine while `structural-lint` flags it as an oversized monolith. Below the
  hint nothing is proposed at all, because a linter that fires on everything is one nobody leaves
  switched on.
- **the block is long enough to be worth a pointer.** A `references/` directory of one-paragraph
  files is worse than a slightly longer document.
- **the block is peripheral**, by cosine to the document's own centre. A long block at the heart
  of the subject *is* the skill, and moving it out would hollow the document while reporting a
  token saving — D4's "the saving-only rule is a document shredder", one level down.

And `NEVER_OFFLOAD` is absolute: a trigger, guardrail, stance or tool contract stays in the body
whatever its length or position. **An agent that has to follow a pointer to discover a prohibition
has already had the chance to break it.**

#### A second embedder, and no second vector table

A6's vectors are one per skill over name, summary and labels — the claim, not the document.
`embeddings.ts` predicted this caller in as many words: body-level similarity needs *"a second
embedder over blocks, a different unit with its own composition, not a wider window on this one"*.
`BLOCK_EMBEDDER_VERSION` is that composition, and it reuses `embedBatch` — same model, same price
entry, same budget check, same ledger row.

**The vectors are computed, used and dropped.** Storing 1.6 million block vectors to keep one
verdict per document is about ten gigabytes for a number that fits in a `real`, and it would put a
second, incomparable population of embeddings beside A6's. Re-analysing a skill costs a fraction of
a cent, which is the right trade while the metric is still being tuned — and tuning it is the whole
point. What is stored is the verdict, keyed on `(skill_version_id, analyser_version)` so a
threshold change cannot silently re-label a corpus that was never re-measured.

`skill_scope` holds **no body text**: a cluster is block ids, so a proposed split resolves live
through the same licence gate the block library uses and a withdrawn skill stops being quotable at
once. `verify:scope` asserts that against `information_schema`, the line `verify:blocks` already
holds for `skill_blocks`.

> **One bug fixed before it could be measured, and it is an old one wearing new clothes.** The
> first version called `readFragment` per block — which fetches the bundle object each time, so
> analysing one 36-block skill would have made **36 round trips to an EU bucket for the same
> file**. That is exactly what `concurrency.ts` exists to record about the derived stages taking
> fifty minutes instead of ten. `readMarkerBody` now does one fetch and one split, and
> `readFragment` is a slice over it — so there is still exactly one definition of where a body
> starts, which is the other bug that file already paid for.

**Cost, measured on the first run and not before it.** 200 skills examined cost **$0.0043** —
1,778 tokens per *judged* skill, 1,085 per skill *examined* once the 38% that are too short to
judge are counted in. The whole public corpus is therefore about **$1.04**, not the $0.77 the
pre-run estimate gave: the estimate assumed 800 tokens a skill and blocks are longer than that.
Same correction the embeddings status line needed when it assumed 60 tokens against a real 84 —
the projection is worth stating and worth replacing with a division the moment there is something
to divide. Never scheduled: it spends, and a job that spends is a job nobody can leave switched on.

#### The first corpus run says the metric is not usable yet, which is what running it was for

200 skills, 122 judged, **$0.0043**:

```
cohesive          59   48%
split-candidate   62   51%
type-aligned       1    1%
too few analysable blocks   76      unreadable  2
```

**51% split candidates is not a finding about the corpus.** A seam that is everywhere is not a
seam, and the honest reading is that 0.22 was a guess with nothing behind it — every observed
separation landed between 0.22 and 0.48, so the threshold sat inside the mass of the distribution
rather than beside it. Exactly the situation the constant's own comment predicted, arriving one
command later.

Two more things the run exposed that no fixture could have:

- **The type-confound guard is inert on most real documents.** 14 of the first 20 candidates
  report no purity at all, because `typeAlignment` returns null when a cluster is mostly
  unclassified — and 58% of corpus blocks carry no type. One `type-aligned` verdict in 63 splits.
  The guard is right and it fires on roughly the third of documents whose blocks are mostly
  typed; on the rest, separation is judged alone. That is a stated limitation now rather than an
  assumption.
- **38% of a random sample has too few analysable blocks to judge.** Reported apart from the
  verdicts and never added to them, because *"we could not judge this"* and *"this is one
  coherent skill"* are opposite facts.

`pnpm scope --calibrate N` is the control that was missing. It glues two **unrelated** skills'
blocks into one synthetic document and measures that seam — the strongest two-skill signal there
is, and therefore the upper bound a real two-subject document should sit below. Each skill is
embedded once and used in both populations, so the control costs no more than the sample. Where
the two distributions stop overlapping is where the threshold belongs; if they never stop
overlapping, RW.10 cannot be built on this measurement, and that is worth knowing before it
reaches an author rather than after.

`pnpm scope --status` now **refuses to present a split share above 25% without saying so**, naming
the calibration command. Same refusal as `archetypes --blocks` printing coverage and the unmet
threshold instead of eleven rows of zeros: the command whose job is to decide whether a feature
gets built must not hand back a confident wrong answer.

> **Two bugs on the way to that run, both mine, and the second is the one worth keeping.** The
> selector joined `skills` on `v.current_version_id` — a column that lives on `skills`, not on
> `skill_versions`. It typechecks, because a `sql` template is a string, and it died on the first
> live execution.
>
> Nothing could have caught it. The suite's stored-rows half skipped while the table did not
> exist, and even afterwards it asserted on the schema and on the data and **never executed the
> selector**. So the selector is now an exported `pendingScopeVersions` that `verify:scope` calls,
> along with `scopeSummary` — both free, one returning ids and the other counts, so there was
> never a reason to leave them unrun. A check that cannot observe the failure is not evidence.
>
> The smaller one: the fix's own comment put a column name in backticks *inside* the `sql`
> template, which terminates it. CLAUDE.md already records that trap from the taxonomy queries.

#### And then the control answered, so the threshold is measured rather than guessed

`pnpm scope --calibrate 60`, **$0.0014**:

| population | p10 | p50 | p90 | max |
|---|---|---|---|---|
| one real corpus document | 0.186 | 0.346 | 0.456 | 0.483 |
| two unrelated skills, glued together | 0.332 | **0.474** | 0.675 | 0.722 |

**The two populations separate.** A real document's p90 sits *below* the glued median, and only
**4%** of real documents reach it. So `MIN_SPLIT_SEPARATION` is now the glued median — 0.474, up
from a guessed 0.22 — and a document above it is at least as separated as half of all documents
that genuinely are two skills. `SCOPE_ANALYSER_VERSION` goes to **1.1.0**, which makes the 122 rows
written at 1.0.0 stale by construction and hands them straight back to the selector. Nothing to
clean: that is the property having the version in the unique key buys.

**The recall cost is real, is chosen, and is stated on the surface.** At 0.474 this misses roughly
half of true two-subject documents — everything below the glued median. The two errors are not
symmetric: a missed split is invisible, and a false one asks an author to cut up a document that
was fine. So the verdict blurb says outright that a `cohesive` result is not a guarantee of one
subject, because the threshold is set to miss rather than to accuse.

Two honest limits on the number:

- **Thin evidence.** n=28 single documents and n=17 pairs, because 38% of a random sample has too
  few analysable blocks and lopsided splits report no separation at all. Worth re-running larger
  before anything leans on it harder than a CLI does.
- **The glued pair is an upper bound, not a sample of real two-skill documents.** Two strangers'
  documents share no author, no voice and no vocabulary; a real two-subject skill was written by
  one person about two jobs that felt related enough to combine, so its seam is necessarily
  softer. Reading 0.474 as "half of all real two-subject skills" is therefore optimistic, and the
  true recall is lower than that.

**The re-run confirmed it, which is why the prediction was stated first.** 200 skills at 1.1.0,
$0.0045: **111 cohesive, 4 split candidates, 1 type-aligned** — 3% against the 4% the calibration
predicted, from 51% at the guessed threshold. A number that moved from half the corpus to a
twenty-fifth of it, in the direction and to the size the control said it would, is the strongest
evidence available that the metric is measuring something.

The four survivors are worth naming, because three of them are suspicious in a useful way:
`to-prd-2` (0.507), `to-prd-3` (0.515), `to-spec-8` (0.504) and `lead-enrichment-sixtyfour`
(0.608). The first three are one family sitting a hair above the threshold, which is either a real
pattern — a *convert to PRD* skill covering two conversion jobs — or one template repeated, and
this corpus has taught us to suspect the second. The fourth is clear of the threshold on its own.
Reading them is the next calibration input, not a task this analyser can do for itself.

**And the confound guard covers one document in seven.** 86% of the calibration sample had at
least one cluster mostly unclassified, so `typeAlignment` correctly returned null and separation
was judged alone. The guard is right where it applies. It is not a general defence, and saying so
is better than carrying an assumption that the confound is handled everywhere — a better block
detector would widen it, which is one more reason `anti-example`'s open question matters.

### The first trust signal that is a person, and the first authority that is not an admin (RK.6, plan step E5)

`src/lib/maintainers.ts` · `src/server/curation/maintainers.ts` · migration 0041
`/curate` · Settings → **Maintainers** · `pnpm maintainers` · `pnpm verify:maintainers` (free)

B2 built one half of RK.6 — typed reader feedback, one queue, one admin deciding all of it. This
is the other half, and it is two things that turn out to be one mechanism: **per-category
maintainer groups** with a real curation right, and **named endorsement** as a social signal
beside the verdicts.

**Every other trust surface here is mechanical.** Verdicts come from analyzers, the quality score
from severities, the archetype from prevalence, the lifecycle from evidence, freshness from a HEAD
request. Not one of them can say *a person who knows this subject has read it and thinks it is
right* — which, over a corpus of 49,000 documents mostly written by strangers, is the signal that
is hardest to fake and most conspicuously missing.

It is also the easiest to make worthless, so four rules carry it:

| rule | what it stops |
|---|---|
| only a maintainer of one of the **skill's own categories** may endorse | an endorsement from anybody, which is a like button |
| nobody endorses a skill published from their own workspace | the cheapest self-dealing there is |
| standing is resolved **live**, never copied | a claim outliving the person who made it |
| the endorsed **version** is pinned | vouching for text the endorser never read |

#### Revoking a maintainer must un-count their endorsements, and that is a join rather than a sweep

The tempting schema stores "endorsed by a maintainer" as a boolean or copies the category onto the
row and trusts it. Both mean somebody who stopped maintaining `review` goes on vouching for review
skills until a job nobody wrote runs. So `skill_endorsements` stores **which category the endorser
spoke as** and nothing about whether they still hold it; every read inner-joins
`category_maintainers` with `revoked_at is null`. Withdraw the standing and the endorsement is gone
from every surface on the next query.

Same decision as A4's supersession join, archetype exemplars resolving live, and the block library
resolving fragments from offsets. Fourth time, and it is a convention now rather than a discovery.

> `verify:maintainers` checks it the only way that proves anything: endorse, read it back, revoke,
> assert it is **gone**, re-grant, assert it is **back**. Reproducing the before state first is
> what makes the after state evidence — the same shape as `verify:http-deadline` and
> `verify:db-retry`. It also asserts the withdrawn standing row is still there, because the
> decisions made under it are in the audit log and a log pointing at a row that exists nowhere is
> unreadable.

#### The earned curation right is bounded by filtering, not by sorting

`flagQueue` takes a `scope`. An admin passes `null` and sees everything; a maintainer passes the
categories they hold and sees only reports on skills in them. **A report they cannot act on is not
a to-do list**, it is somebody else's work rendered as though it were theirs.

Two things that look like details and are not:

- **an empty scope returns nothing, not everything.** `scope = []` is *a maintainer of nothing*,
  and the natural `if (!scope.length) skipTheFilter` reading of that turns a new appointee into a
  second admin. It is an explicit early return with a comment saying so, and a check in the verify
  suite.
- **the pair is matched on both halves.** `function` and `domain` are separate vocabularies with no
  guarantee of disjoint slugs, so `value in (…)` would widen somebody's queue across the axis they
  were never appointed to — the case-insensitive-repo-lookup bug one layer up.

`decideFlagAction` re-checks on the POST rather than trusting the page that rendered the queue,
because a server action is an endpoint. The two authorities stay separate: an admin who maintains
no category can decide any report and can endorse nothing.

#### `/curate` is its own page, and `/settings` did not move

`/settings` is admin-only three times over. Letting maintainers through to see one card out of
seventeen would have weakened the only guarantee that page makes. A maintainer is **not a junior
admin** — full authority over their categories, none at all over the platform — and two pages say
that where one page with conditionally hidden tabs would not. Appointing maintainers stays behind
the admin page: a maintainer earns a curation right, not the right to make more maintainers.

#### The empty state is the part that took the most care

Forty-two categories, a group appointed one at a time, and 49,000 skills. So for a long while
most skills will carry no endorsement — and *nobody was eligible* and *the eligible people
declined* are the same empty list and opposite conclusions. `EndorsementView` carries the eligible
count and the covered category names beside the list, and the card prints whichever sentence is
true. Printing "No endorsements" for both would be `archetypes --blocks` rendering eleven rows of
zeros at 1% coverage, in a friendlier font.

The settings panel lists **the categories with nobody**, derived from the real vocabulary rather
than a remembered list, for the same reason `/archetypes` lists the categories below the evidence
gate: a clean grid of what is covered looks finished and says nothing about where the group is
thin.

#### It is never a score, and it cannot be sold

No badge in the skill page's header row, no column in the registry list, no sort. Endorsements will
be single digits over tens of thousands of skills, and ranking on them would put four documents
above forty-nine thousand on the strength of who happens to have a maintainer group — the argument
that keeps popularity out of R2.9's search ranking.

`endorsements` is the ninth **`FREE_FOREVER`** key, so the entitlement gate throws if anything asks
whether a workspace may see it. It belongs there more obviously than most: the *absence* of an
endorsement is the half a reader needs, and a registry that gives away its good news and charges
for the warning is worse than one with no endorsements at all.

### The knowledge graph, most of which is deliberately not stored (RK.3, plan step E2)

`src/lib/relations.ts` · `src/server/analytics/relations.ts` · `src/server/analytics/conflicts.ts`
migration 0040 · `pnpm relations --status | --conflicts N` · `pnpm verify:relations` (25 checks, free)

The obvious build is one `skill_relations` table holding every edge. It is also **three second
sources of truth**, and this codebase has paid for that shape enough times to recognise it:

- **`similar-to` already lives in the A6 vectors.** A stored copy is a snapshot that a re-embed
  invalidates, and resolving it live is one `<=>` against an index that exists — free, and correct
  by construction.
- **`supersedes` already lives on `skills.superseded_by_skill_id`.** A4 made that a *live join*
  precisely so a replacement quarantined since stops being recommended; copying it into an edge
  table resurrects the stale-pointer problem A4 solved.

So the table holds the two kinds with nowhere else to live — **mined conflicts**, which cost a
model call per pair, and **author-declared** edges, which are somebody's assertion. `relationsFor`
composes all four at read time, and which are stored is an implementation detail. Declaring a
derived kind is **refused with a message naming where the answer lives**, rather than silently
accepted or silently dropped.

#### The conflict half has no equivalent anywhere in the system

Every other measurement judges one document. This is the first claim about a **pair**: install
both and one says *always*, the other *never*. Nothing in validation can see it, because each
document is individually fine.

Guardrails are the input, and A2 said so when it defined them — *"correlates with passing
validation; the input to conflict detection (RK.3)"*. A guardrail is unconditional by definition,
so two either agree, address different things, or contradict. A procedure can differ without
disagreeing.

**Three filters before a model is called, and they are what make it affordable.** One call per
pair is still 240,000 calls over this corpus if the pairs are chosen badly:

1. near neighbours only — a Terraform rule and a legal-review rule are not in disagreement, they
   are about different things;
2. both sides must actually carry guardrails, which most skills do not;
3. the two sets must share a significant word — free, and on a first real sample it removed 2 of
   11, which is useful and much weaker than the first two. Worth stating rather than assuming:
   the similarity threshold does most of the work and this filter earns its place by costing
   nothing, not by being decisive.

`--conflicts` prints the gap between pairs considered and pairs called, because that number is
what says whether the job is affordable at scale and it is invisible otherwise. One call per
*pair*, not per guardrail pair: both sets go in together and the model returns the cross-pairs
that contradict. The quadratic version is the obvious one and is the difference between a job that
finishes and one that does not.

> **The first candidate query did not run slowly — it did not finish.** It joined
> `skill_embeddings` to itself with no join condition and filtered on the distance afterwards: a
> cross product. With **30,133 skills carrying guardrails that is 454 million** distance
> computations over 1536-dimension vectors, and the trailing `LIMIT` cannot help because the
> predicate has to be evaluated across the whole product first. An HNSW index can only serve
> `order by … limit k`, so the rewrite is a bounded top-K lateral per source with **nothing else
> inside it** — extra predicates push the planner back to a scan, the well-known filtered-ANN trap.
> Every other condition is applied to the K rows that come back. 5 sources, 3 pairs, 6.9 seconds.
>
> Sources are sampled **at random**, and that is a stated limitation. A pair produces a row only
> when it *conflicts*, so "compared and clean" is recorded nowhere and there is no incremental
> selector to write; ordering by id would re-examine the same head of the corpus for ever.
> Random sampling grows coverage probabilistically and may re-ask a clean pair. Same posture as
> `taxonomy --sample`, and if corpus-wide coverage is ever wanted the missing piece is a record of
> clean comparisons — a table, not a tweak.

> **`= any(${jsArray})` in a `sql` template, for the fourth time.** Drizzle renders a JS array as a
> **row constructor**, so Postgres answers *op ANY/ALL (array) requires array on right side* — at
> runtime only. The lifecycle branch shipped it, E1's link prune shipped it, this step's guardrail
> lookup shipped it, and a tree-wide scan added in response found a **fourth**: `deleteStoredBundles`
> in the takedown path, guarding an irreversible bundle delete, latent since it was written because
> the branch containing it cannot currently fire.
>
> `verify:relations` now scans every file for the pattern. Its own first version was too crude and
> is worth recording: it matched the *warnings* about the trap, so three of five hits were prose in
> the files that had already been fixed — a scanner shouting loudest where the problem is least. It
> strips comments now and allows the correct `any(${sql`array[…]`})` form.

> **The prompt spends most of its length on what is *not* a conflict, and the first version of it
> did not work.** The first real mine returned **0 conflicts across 13 pairs** — which is either an
> honest finding or a detector that cannot fire, and *nothing in the suite could tell those apart*,
> because every check mocked the model and therefore tested everything except whether the prompt
> works.
>
> So `verify:relations --live` drives the real model with three controls, for about $0.002: a plain
> contradiction, two unrelated rules, and a stricter-than pair. Both directions are needed — a
> detector answering "conflict" to everything passes a positive-only test, and one answering "no"
> to everything passes a negative-only test.
>
> It found the failure immediately. *"At least one reviewer"* against *"at least two reviewers"*
> was reported as a conflict, with the reasoning that a change with exactly one reviewer would
> violate the second — which is wrong, because getting two satisfies both. That is the commonest
> shape of rule in any corpus, and it was the exact case a bullet in the prompt already warned
> against and the model was not applying.
>
> **1.1.0 replaced the list of exclusions with a single test**: *is there any one course of action
> that satisfies both rules? If yes, there is no conflict.* Plus a worked example of the
> stricter-than case, because a rule stated abstractly is a rule a model can agree with and then
> ignore. All three controls pass.

> **The first real finding, and it is a good one.** After 1.1.0, a 20-source run found **one
> conflict** across 10 pairs called, for $0.0153: `orbit-gmail-2` and `orbit-general-2` each carry
> a verbatim *"Use exclusively the colors / fonts / radii defined in `example.html`"* alongside a
> separate *"This is a hard constraint"* — one baking in Google Sans and Material chrome, the other
> Cormorant and Inter. An agent holding both, asked for a briefing, has two absolute rules
> demanding different fonts. Nothing in validation could see it: both documents are individually
> exemplary.
>
> Checked against the source guardrails rather than taken on trust, because this text renders on a
> public page and accuses somebody's work. The two quotes are exact; the one-sentence *why* is the
> model's own prose and drew a detail from elsewhere in the same guardrail set, which is why the
> **quotes** are the evidence on screen and the sentence is only the explanation. Two rows were
> written, one per direction, which is the symmetric-edge design doing its job.

> **What the live run also showed about the input.** The guardrails reaching the detector are often
> long expository paragraphs rather than unconditional rules — the block extractor types a passage
> `guardrail` on modal verbs, so a page of prose containing "must" and "required" qualifies. The
> plumbing is right and the raw material is coarser than the design assumed, which is a reason to
> read a zero here as *"probably none among these pairs"* rather than as a corpus-wide finding.

#### Symmetric edges are written as a pair, in one statement

A conflict reads the same from either end, and there were two ways to store it: one row with a
canonical ordering, or two written together. Two, because every read is then `where from_skill_id
= $1` with no `or` and no ordering convention a later query can forget — and because a one-sided
conflict would warn half the callers it should while looking completely normal from either page.
`verify:relations` writes one edge and asserts both skills see it.

**The warning warns and does not refuse.** It reaches an agent through `get_skill` *and*
`download_skill` — an agent is not obliged to read a skill before taking it, so the last moment it
can matter is the call that hands over the bundle. But a conflict is a measurement over two
documents, not a licence or a takedown: the refusals here are for things nobody may do, and a
caller may have good reason to install both.

### Demand signals: the only surface that turns user text into a public page (RK.5, R5.3, step E3)

`src/lib/demand.ts` · `src/server/analytics/demand.ts` · `/wanted` · migrations 0038–0039
`pnpm verify:demand` (30 checks, free)

Every other measurement here reads the corpus — archetypes describe what people wrote,
similarity describes what exists, the trust surfaces describe what passed. Not one can see the
thing a reader came for and left without, which is the only signal that says **build this**.

So a search that returns nothing is logged, on the web and through MCP, and a query enough
distinct people asked becomes a public most-wanted board. That closes **R5.3's second half**: B3
tells an author twelve near-identical skills already exist, and this tells them nobody has written
the one people keep asking for. Both sit beside the purpose field, because showing only the first
makes the builder a discouragement machine.

#### The floor is the whole safety property

A search query is user-typed text and the board is public. `"review our acme corp msa for renewal
terms"` is a demand signal and also somebody's Monday morning, and the distance between the two is
one missing `HAVING` clause. The naive board — `group by query order by count(*) desc` — publishes
something one person typed once, and that is not a subtle failure: it is the feature working as
written. `verify:demand` reproduces it first.

Two defences, neither optional:

- **No identity is stored.** No org, no user, no address — a daily-rotating HMAC and nothing else,
  so *"what did this customer search for"* is a question the schema **cannot** answer. Not "does
  not today"; there is no column to join, and adding one is the change to refuse.
- **Five distinct searchers** before anything is publishable. The floor is a `HAVING` clause in the
  query *and* re-applied on the way out, because a future CLI or API that forgets is the one nobody
  reviewed.

> **The mirror-image bug, and it is the harder one to see.** The first version passed `callerKey:
> null` for anonymous web searches, reasoning that under-counting distinct people is the safe
> direction for a privacy floor. It is not: `callerDigest(null)` returns one shared constant, so
> every anonymous search would have collapsed to a single digest and **the floor of five could
> never be reached** — a permanently empty board, for a reason that looked like caution. It now
> uses the same forwarded address the download route and the write limiter already use, hashed
> daily and never stored.

#### Smaller decisions

- **Only the normalised query is stored.** `Terraform Review` and `terraform  review ` are one
  signal; the raw text adds nothing to a count and everything to a disclosure.
- **Median, not mean.** A query answered once out of forty has a mean of 0.27 and a median of 0.
  The median is what a searcher experiences; one outlier moves the mean.
- **Page one only.** Paging is the same search asked again, and counting page three would triple
  one person's demand.
- **A query the corpus answers leaves the board** however many asked. This is a gap board, not a
  popularity board, and the suite asserts the difference.
- **Trigram-indexed**, so R5.3's author-facing match is free and renders with the panel rather than
  behind a button — the distinction `findSimilarAction` had to draw because its match is a metered
  embedding and this one is not.

### Freshness: the mechanism had no way in, and one kind of decay nobody declares (RK.2, plan step E1)

`src/lib/freshness.ts` · `src/server/skills/links.ts` · Settings → **Freshness** · migration 0037
`pnpm links --status | --check N | --rotten` · `pnpm verify:freshness` (31 checks, free)

A4 shipped `review_by` and a derived `stale` state with **no web entry point at all** — only
`pnpm lifecycle --review-by`. Its own note said why the panel waited: *one that can set a review
date but cannot yet tell anyone it has passed is furniture.* E1 is the telling-anyone half.

**Undated is not neglected.** A review date is a governance decision somebody made, and its
absence means nobody has made one. The queue selects only dated skills; the alternative lists
49,000 rows and is ignored by lunchtime — the same reason `db:audit` stopped reporting retained
history as outstanding work.

#### Link rot is the only freshness signal nobody has to declare

Everything else about staleness is a judgement expressed as a date. A dead link is a fact, and it
is the commonest way a skill quietly stops working: a `reference-pointer` to a vendor page that
moved sends an agent nowhere, and every analyzer still passes.

**Most non-200 responses are not rot**, and the naive rule — anything ≥ 400 is broken — fills the
panel with sites that dislike robots. Four statuses instead:

| | |
|---|---|
| `broken` | 404 or 410 — the page itself saying it is gone. The only confident one. |
| `blocked` | 401, 403, 429 — the server refusing *us*. A fact about our user agent. |
| `unreachable` | timeout, DNS, 5xx. Often the network, often temporary. |
| `ok` | it answered |

And a single failure is never rot: `consecutive_failures` must reach `ROT_THRESHOLD` (2), reset to
zero the moment a check succeeds so a recovered link stops accusing immediately. A panel that
cried wolf on a deploy or a rate limit would be ignored inside a week — the
alarm-nobody-can-silence problem arriving from the other direction.

> **`HEAD` then `GET`, and the fallback is not politeness.** A great many servers answer `405` or
> `501` to `HEAD`, and reading that as a dead page would be the single largest source of false
> rot. The retry is a one-byte ranged `GET`. `verify:freshness` starts a local server that refuses
> `HEAD` and asserts the fallback end to end — no third party is contacted by the suite.

**A state table, not a log**, which is the opposite of this repo's default. `verdicts`,
`eval_runs` and `llm_usage` are append-only because each row is evidence about a moment; a link
check's entire value is *is this broken now*, and a log would grow by URL × check to answer a
question only the newest row answers. The history worth keeping is the two numbers the rot rule
reads, so they are columns.

Keyed on the **version**, not the skill: re-sync produces a new document with possibly different
links, and keying on the skill would carry a dead URL forward onto a document that no longer
contains it.

#### Coverage travels with the count

"4 dead links" over a corpus 3% checked reads as a healthy corpus — the `archetypes --blocks`
misreading in a new place. The panel and the CLI both lead with how much has been checked, and
the panel states what it is *withholding*: how many blocked and unreachable links it found and
why neither is listed. A reader who does not know the list is the confident subset will read it as
the whole answer.

> **Three bugs the first real pass found, none of which reading could have.** Running
> `pnpm links --check 200` over the corpus is what turned each of them up.
>
> **The rot threshold was unreachable by construction.** 50 links returned 404 and *none* were
> reportable, because rot needs two consecutive failures and an oldest-first selector returns to a
> given document once per sweep — 245 passes, at 200 a time over 49,000. A document with an
> outstanding failure now jumps the queue after `RECHECK_AFTER_HOURS`, and stops jumping once the
> failure is confirmed, so discovery is not starved either. `verify:freshness` backdates a row and
> drives `nextTargets` rather than asserting the SQL exists: the first kind of check would have
> passed throughout.
>
> **Most of the "unreachable" links were placeholders the filter should have caught.**
> `api.example.com`, `staging.example.com` and `attacker-server.example.com` are subdomains of an
> RFC 2606 name and the filter matched the bare name only; `http://burpsuite` and `http://model_a`
> have no dot at all. 27 of 308 rows, each costing a real DNS lookup and landing in the panel as
> true and useless. Widening it needed a **prune**, too — a version is immutable, so its link set
> only changes when the extraction rules do, and orphaned rows would have sat there for ever.
>
> **`<> all(${array})` in a `sql` template is a row constructor, not an array.** Postgres answered
> *malformed array literal*. CLAUDE.md already records this trap from the lifecycle branch, where
> the same cause produced *op ANY/ALL (array) requires array on right side* — it shipped again
> because the template form reads so naturally. `notInArray` is the fix, both times.
>
> A fourth, smaller: `metadata_only` skills have no stored bytes, so they produced nothing, sorted
> to the front as never-checked, and **sorted to the front again next pass** — starving the queue
> behind them. Excluded from the selector rather than marked checked, because a row saying "looked,
> found nothing" would be a claim about a document we cannot open.

> **The extractor had the bug its own comment warned about.** A URL inside backticks kept the
> closing backtick, and a URL with a stray character 404s — which is the one verdict this module
> treats as confident. The backtick is now excluded from the character class rather than stripped
> afterwards, because it can never appear in a URL; `*` and `_` are stripped in trailing position
> only, since both are legal inside one and neither ever ends one. Found by the suite, not by
> reading.

> **And one type that lied.** `linkCheckSummary` annotated `min(checked_at)` as `sql<Date | null>`
> and the CLI called `.toISOString()` on the string the driver actually returns. `sql<T>` is a
> *claim about* a value, not a conversion of it — drizzle applies no parser to a raw expression.
> Same shape as reading `usage.inputTokens` from `embedMany`, which returns `undefined` and meters
> a backfill as free. It is typed `string | null` now and converted once, at the boundary.

One cache per pass, too: the corpus links to the same handful of vendor docs thousands of times,
and asking one host four hundred times in a run is how a crawler gets blocked — which would then
be recorded as `blocked` on four hundred skills.

### Impact analytics: two functions that had been written and never read (RK.7, plan step E4)

`src/components/registry/impact-card.tsx` · `src/components/archetypes/outcome-card.tsx`
`pnpm verify:impact` (17 checks, free) · no migration

`outcomesForSkill` and `archetypeOutcomes` shipped with B1, fully typed, and had **zero call
sites** for a milestone. Unreachable code is indistinguishable from absent code to everybody
except the person who wrote it, so E4 is entirely a surfacing job — the smallest real win left in
the programme, and the plan said so.

#### A zero has to say which kind of zero it is

Most of this corpus was indexed before the recorder existed. The live numbers make the point:
collection began **2026-09-07**, and the first skill sampled was indexed **2026-09-01** — so its
"0 downloads" means *nobody was counting*, not *nobody wanted it*. Same shape as
`archetypes --blocks` printing eleven rows of zeros at 1% coverage, and the same fix: carry the
window with the number.

`outcomeCollectionStart()` derives it from `min(at)` rather than a configured date, because a
constant would be a second source of truth for something the table already knows — and would be
wrong the first time the table is backfilled or pruned. Null renders as *nothing has been
recorded anywhere*, which is a different sentence from zero of anything.

#### The impact card deliberately does not render a battle-tested badge

`outcomesForSkill` computes one and `lifecycleExpression()` computes one in SQL — **with
precedence**, so a deprecated or superseded skill keeps that state whatever its download count.
Two badges from two computations would eventually contradict each other on the same page, and a
reader would have no way to know which was right.

So the card shows the **evidence** and what the tier is still waiting for: *18 of 25 downloads,
no clean re-validation yet*. That is the more useful half anyway — "battle-tested" tells a reader
nothing they can act on, and the gap does.

#### The archetype half is honestly empty, and the panel is built to stay honest as it fills

Only skills published through the builder carry archetype lineage, and there is essentially one.
`usable` is false below `MIN_DISTINCT_SKILLS`, and below the floor the counts are **withheld
rather than greyed out** — a muted number is still a number somebody will quote, and this one
would describe one or two specific skills rather than the archetype. `verify:impact` writes a
single-skill probe and asserts it appears and is not reportable, then rolls it back; asserting on
whatever the table happens to hold would pass today by accident.

> **Why the open read policy is safe, asserted rather than assumed.** `outcome_signals` is
> `SELECT … USING (true)` on purpose: cross-organisation aggregation is the whole point of
> `archetypeOutcomes`, and an org-scoped read would make it describe one tenant at a time. What
> stops a private skill's counts leaking is that the *skill* lookup is org-scoped, so a signal is
> only reachable through a skill the reader could already see. The suite checks the policy shape
> and checks `information_schema` for any column that could hold tenant content — clean data says
> nothing about the next migration, which is the line `verify:blocks` already holds for
> `skill_blocks`.

### A commit that built locally and not on the deploy, and the check that can see it

`scripts/verify-tree.mts` · `pnpm verify:tree` (5 checks, free, offline)

Commit `09cf61f` staged every **modified** file and no **new** one — the signature of `git add
-u`. So `page.tsx` shipped importing a `matrix-panel` that was not in the commit, and the
production build failed on a module that was open in the author's editor at the time.

Nothing in the suite could see it. `typecheck`, `lint` and `build` all read the **working copy**,
which has every file whether or not git knows about it, so all three were green on the machine
that wrote the code and the failure only existed on the machine that cloned it.

That is the second time "the tree does not match reality" has cost a deploy, in a different
disguise each time — the first was migration 0031 applied and then removed, leaving a database
ahead of a tree that could never reproduce it. `db:audit` catches that direction by counting
applied against on-disk; this catches the other.

**It asks one question of three places: would a fresh clone have this?**

- every `@/…` and relative import in a tracked file resolves to a tracked file
- every migration the journal names has its `.sql` committed, plus the newest snapshot
- every `verify:*` in `package.json` points at a committed script

Each failure says whether the target is **on disk but never added** or missing entirely, because
those need opposite fixes and guessing between them is most of the time lost to a red build.

> **Two things about the checker itself are worth keeping.** Its first regex bounded a module
> specifier with `[^"']+`, which spans newlines — so an apostrophe in one doc comment matched a
> quote several paragraphs later and it reported a page of prose as an unresolved import. A regex
> that can match the wrong thing reports the wrong thing confidently.
>
> And it originally asserted **every** drizzle snapshot was committed, which is permanently red:
> `0023` has been missing one since it was written and nothing depends on it. Only the newest
> matters, because that is what the next `db:generate` diffs against. The rest are noted, not
> failed — an alarm nobody can silence stops being read, which is the lesson `db:audit` already
> paid for.

The dynamic-import case is the one that mattered here: the broken call was
`await import("@/server/evals/matrix")` inside a server action, which a grep for `^import` would
never have seen. Same shape as the `aws4fetch` grep that returned clean and meant nothing.

### The optimiser: a cheaper skill, proven before it is offered (RW.9, plan step D4)

`src/lib/variants.ts` · `src/server/evals/optimise.ts` · migration 0036
`pnpm verify:optimise` (24 checks, free)

A3 put a token estimate on every skill — *this costs 4.2K tokens every time it fires* — and that
was half a feature. RW.9's actual pitch is **here is a 1.9K version with identical eval results**,
and the load-bearing words are the last three.

Anyone can ask a model to halve a document. The hard half is the evidence, so a variant is
**never offered until it has been run against the skill's own eval cases**, and the outcome leads
the number rather than following it.

#### The saving-only rule is a document shredder

`verify:optimise` opens by reproducing it: a variant 40% shorter that fails a case the current
document passes. The naive rule offers it, and −40% reads as a triumph. Three conditions gate an
offer, and dropping any one breaks the feature:

- **Nothing regressed.** One case that passed before and fails now disqualifies it outright,
  whatever the saving. Something load-bearing was cut, and the regressions are named case by case
  — "it broke something" without saying what is a result an author cannot act on, and the natural
  response is to try again, which spends money to learn the same thing.
- **Something was actually compared.** An unverified cut is a shorter string.
- **The saving is real.** Under 10% is inside the estimator's own error.

`error` on either side makes a case *incomparable* rather than regressed, and a case run on only
one side is excluded rather than assumed to have held — an unmeasured case is not a passing one.
A "compression" that grew the document reports a negative and is not offered.

#### It needed no new results store, and accepting needed no new writer

The variant gets its own content hash, and `eval_runs` is keyed by hash already — so running the
cases against it stores ordinary rows and the comparison is two reads of one table. Same reason
D2 reads D1's probes rather than keeping its own.

Accepting hands the compressed prose to **`importDraftBody`**, the same path a generation takes,
so it comes back as typed blocks and `skill_drafts.body` keeps its single writer. That is C1's
design paying off: the optimiser produces prose and never learns blocks exist. `verify:optimise`
asserts the absence of a body write here as well as in `verify:draft-blocks`, because this is the
most tempting place in the codebase to add one — the variant *is* a body, and one update would
do it.

> **An offer is a claim about specific bytes.** `source_hash` is stored and the offer stops being
> current the moment the original is edited — the comparison was against something that no longer
> exists. Same rule the eval panel applies to a stale verdict, one level up. An earlier proposal
> is `superseded` rather than left beside the new one: two live offers for one document is a
> choice nobody asked for, and they were measured against the same source so nothing an author
> can see distinguishes them.

Smaller ones: the outcome is **stored** rather than recomputed on read, unlike almost everything
else here — it is a fact about a comparison between two frozen documents, and recomputing it
later against runs that have since accumulated would change a historical claim. Temperature zero,
because an author is comparing two documents rather than browsing options. And taking a variant
on a *published* skill is refused in words: its body lives in object storage behind the hash a
verdict covers, so replacing it is a re-publish rather than an edit, and that is C6's problem.

**M3 is complete.** R2.11, RW.6, RW.7, RW.8 and RW.9 are all closed, R6.3's collection half with
them, and the paid tier is a product rather than a plan: a skill can now be shown to fire when it
should, to do what it claims, to help more than nothing, and to do it for less.

### The with/without matrix, and R6.3's collection half is finally complete (RW.7, plan step D3)

`src/lib/matrix.ts` · `src/server/evals/matrix.ts` · migration 0035
`pnpm verify:matrix` (24 checks, free)

Skill CI says the golden tasks pass. It cannot say whether they would have passed anyway — and
a skill carrying no knowledge a capable model lacks is indistinguishable, from inside CI, from
one carrying a great deal. That difference is the entire value proposition, so each golden task
now runs four ways: with the document and without it, across two models.

**Two models, because "it helps" is usually "it helps this one."** A skill that lifts a cheap
model towards a capable one's baseline is a real and saleable finding, and a *different* finding
from one that lifts both — which a single-model matrix reports identically to no effect at all.
The default pair is Sonnet and Haiku for exactly that contrast.

**`eval-delta` is written**, which empties `UNIMPLEMENTED_KINDS` and completes R6.3's collection
half. The value is signed: a skill that made results worse records a negative, because that is
the finding this milestone exists to surface and the one an author is least likely to look for.
Only for a published skill — the signal attaches to a `skill_version` and a draft has none, so a
matrix while authoring measures without recording, and the panel says which happened.

#### Half a measurement renders as a perfect result

A delta is a subtraction between two arms, which gives it a failure mode none of the other
measurements have. If the budget refuses partway through, the with-arm ran and the without-arm
did not, and the naive subtraction reads `1 − 0` as a **flawless +100 points**. A number wrong in
the flattering direction is the one nobody questions.

So a delta is computed only over tasks with a decided verdict in **all four cells** at the
current document. Incomplete tasks are counted and excluded. `verify:matrix` reproduces the naive
form producing +100 from one arm before asserting the real one declines.

`error` is dropped from both numerator and denominator, and here that matters more than in CI: a
refusal in the *without* arm would read as the skill helping.

> **The interaction that would have shipped silently.** D1 takes the newest run per case as the
> case's state, and a matrix writes a run per arm — where the without-arm is *supposed* to fail.
> Without a filter, a successful matrix would make every golden task look freshly broken and the
> publish gate would call it a regression. `eval_runs.with_skill` is nullable and **NULL means a
> Skill CI run**; `evalStates` filters on `is null`. A boolean rather than an arm enum because
> the model is already a column: the four cells are `(with_skill, model)`, and a second name for
> a pair the row already carries is how two descriptions of one thing start to disagree.

#### Smaller decisions worth keeping

- **The two arms have separate prompts**, written out rather than one template with a
  conditional. The difference between them *is* the experiment, and a shared template is one
  edit away from a variable neither arm controls.
- **A cell already measured at this document is skipped.** Eight calls a task makes a second
  press the most expensive no-op in the product.
- **The sample size is not stored on the signal.** `outcome_signals` carries a kind and a value
  and no free-text column, which is what makes its read policy safe; how many tasks a delta came
  from belongs with the runs, which are already rows.
- **`evalParentFor`** fixes a wart D1 left: `publishDraft` re-points cases from the draft to the
  skill, so `{ draftId }` after publication finds nothing and the eval panel, trigger lab and
  matrix would all read as data loss. One helper, at the four call sites that need it — the
  fourth being the one it would have been forgotten at.

> **This makes migration 0035 a hard dependency of the eval surfaces.** `evalStates` selects
> `with_skill`, so `verify:evals` and `verify:trigger` fail with `column does not exist` until it
> is applied. Migration-before-code, loud rather than silent, and worth knowing before wondering
> why two green suites turned red.

### The trigger lab, and a budget that was pointed at the wrong pocket (RW.8, R2.8, plan step D2)

`src/lib/trigger.ts` · `src/server/evals/trigger.ts` · `pnpm verify:trigger` (31 checks, free)
`pnpm verify:trigger --live` adds 4 more and **costs a fraction of a cent**

**No new tables, and that was the point of building D1 first.** An earlier ordering had the
trigger lab independent of Skill CI, which would have produced two probe tables — should-trigger
cases and trigger probes are the same concept at different aggregation levels. Everything here
reads `skill_evals` and `eval_runs`, so there is nothing to keep in step.

#### Two proxies, never averaged

- **Precision and recall** judge the *description as written*: would a reader of that sentence
  reach for this skill. That is the thing an author can fix.
- **Collision** is a *retrieval* signal over the A6 vectors: of everything in the corpus, does
  this request land nearer to something else. It is the only half that can name **which other
  skill would win**.

They disagree usefully — a description can be perfectly clear and still lose every request to a
better-known neighbour — and a single "trigger score" would hide which. That is the
`quality_score` mistake in a new costume.

Free and paid split on **what each half spends**, not on what is worth selling: precision and
recall are arithmetic over rows that already exist and cost nothing; collision embeds every
probe. The plan's "quick check free, full lab Pro" falls out of that.

#### Every empty number says why it is empty

`0/0` is `NaN`, and the obvious repair — `|| 0` — turns *nobody has measured this* into *this
never fires*. The repair is the bug, and 0% is a perfectly plausible recall. Worse in the other
direction: precision with nothing fired, defaulted to 1, gives a skill that never triggers a
**perfect score on the axis it fails hardest**. Both return `null`, and `null` stays null all the
way to the screen. `verify:trigger` reproduces both naive forms before asserting the real ones.

A rate counts only runs stamped with the current document's hash; stale and never-run probes are
reported beside it rather than folded in, and an `error` verdict is dropped from both columns —
our outage must not move a number the author is being asked to act on.

> **The collision path had a bug that only running it could find.** `nearestToVector` rounds
> similarity to three places and this side did not, so a neighbour whose raw score sat a
> ten-thousandth above the skill's was filtered in and then rendered at the *same* three-place
> number — a panel reading `this skill 0.702 · nearer: X 0.702`. Both sides round before
> comparing now, which also makes the tie rule mean what its comment says. That is why
> `--live` exists at all: an index that has never answered a query is an index nobody knows is
> wrong.

#### A customer's embedding was billing the platform, and had been since B3

`embedBatch` hard-coded `purpose: "corpus_embedding"` and a null org. Right for the backfill,
**wrong for anything a person sets off** — and R3.6's author similarity check has been charging
the corpus-analysis budget since B3, with the collision lab about to do the same once per probe.

RC.2 keeps two budgets precisely so that *a busy month of authoring must not halt corpus
analysis*, and this was the mixing it exists to prevent. `embedBatch` now takes an `EmbedScope`
defaulting to the platform, so every existing caller is unchanged; the similarity check bills
`builder` and the collision lab bills `eval`, both against the workspace that asked.

The symptom is a row in the wrong column — everything works, the numbers are right, and the only
sign is the platform budget draining faster than the backfill explains. So it is asserted against
the source tree rather than trusted.

> **Two cleanup bugs in the same afternoon, both found by counting rows after a *green* run.**
> `verify:evals` deleted its ledger rows by looking eval ids up through `draft_id` — but a
> successful publish re-points every case to `skill_id`, so the subquery found nothing. Widening
> it to follow the re-point still missed two rows, because the test deliberately **deletes** one
> case to clear the publish gate and `llm_usage.subject_id` is plain text with no foreign key, so
> those rows are orphaned the instant the case goes. The ids are now remembered as they are
> created. A suite that passes and leaves charges behind is a suite that inflates the number the
> next cap decision is made on.

### Skill CI: the first surface that says a skill *works* (Doc 2 R2.11, Doc 6 RW.6, plan step D1)

`src/lib/evals.ts` · `src/server/evals/` · migration 0034 · `pnpm verify:evals` (34 checks, free)

Everything the platform said about quality until now was a statement about **form**: the
analyzers say a document is well-formed, the archetype says its shape matches what the corpus
rewards, the quality score adds those up. None of it says the skill works — which is the
difference between a registry and a product, because a paid tier built on "our validator likes
it" is a paid tier built on our opinion.

**One probe model, not two.** `skill_evals` holds should-trigger probes, should-not-trigger
probes and golden tasks in one vocabulary, because those first two and RW.8's trigger probes are
the same concept at different aggregation levels. D2 reads these rows rather than a parallel set
that could disagree with them about whether a skill fires.

#### A regression blocks a publish. Any failure does not.

The obvious rule is "a failing case blocks publication", and it is wrong. An **aspirational**
case — written to say what the skill should eventually do — has never passed, and failing is its
correct state. Under the naive rule the author cannot ship, learns that writing cases costs them
the ability to ship, and stops writing them. The gate would then protect nothing.

So the gate is: *this case passed against an earlier document and fails against this one.*
Something the skill did, it no longer does. `verify:evals` reproduces the naive rule first and
shows it blocking the aspirational case, then shows the real rule letting it through.

Three more distinctions the panel and the gate keep rather than flattening:

- **`error` is not `fail`.** A refused call or a provider outage is a fact about us. Counted as
  a failure it would let our own downtime block a customer's publish and read as a quality
  regression on their skill.
- **Stale is not failing.** A verdict about an older document is not a weak claim about this
  one, it is not a claim about this one at all. Stale results are marked and gate nothing.
- **Two runs against the same document cannot be a regression**, or a non-deterministic judge
  would block a publish nobody changed anything for.

#### Nothing runs automatically, against the plan

The plan says "every edit re-runs". Taken literally that bills a model call for every save in a
block-editing session — the shape `findSimilarAction` already refused when it made similarity a
button rather than an autocomplete.

What that instruction is *for* is that a result must never describe an older document, and
stamping every run with the document's `content_hash` delivers exactly that, for free and more
honestly: a stale result is **visibly stale** rather than being replaced by a run the author did
not ask for and did not budget for. The run button also skips any case already judged against
these exact bytes, so pressing it twice costs nothing.

#### The trigger probe never sees the body, and that is the whole point

A probe is handed the skill's **name and description only**. That is what a consuming agent
matches on in the Agent Skills standard, so a probe with the body would be testing something no
agent reads at selection time — it would pass for skills whose description never fires, and
report that as triggering precision. A confident wrong answer of exactly the `quality_score`
banding kind. `verify:evals` reads the two functions and asserts the asymmetry.

**A golden task is two calls and has to be.** One hands the whole skill to an agent-class model
and lets it do the task; the other hands the output and the author's expectation to a judge. One
call that produced and graded its own answer is not a judge — it is a model asked whether it did
well, and it says yes. Two model settings (`evalAgent`, `evalJudge`) rather than one, so that
stays structural.

> Golden-task confidence is deliberately **null**. The task is met or not met, and a confidence
> number beside a binary judgement invites somebody to rank on it — which is how the archetype
> miner came to band on `quality_score`.

#### Smaller decisions worth keeping

- **Exactly one parent, enforced by the database.** `draft_id` and `skill_id` are both nullable
  with a check constraint; `publishDraft` re-points a draft's cases onto the skill inside the
  same transaction. Re-pointed, not copied — a copy would leave the run history behind on the
  draft, and the history is the only thing that makes a regression detectable.
- **`eval_runs` is append-only.** No UPDATE, no DELETE. The publish gate reads these rows, so an
  application that could edit them could clear its own gate.
- **Cases are org-owned even against a public skill.** A case is the workspace's claim about
  what that skill should do, not a fact about the skill. RC.5 holds with no special case.
- **Writing is free, running is Pro.** The entitlement sits in the action, not the runner, so a
  CLI or a later re-scan reaches the runner without depending on a resolvable organisation. A
  free-tier author keeps the notepad — which matters, because the interview fills it for them.

#### The C2b gap is closed, and closing it needed a schema change

RW.4 promises that a captured worked example becomes an eval case, and C2b could not deliver it
because `skill_evals` did not exist. It does now — but the obvious wiring was wrong and worth
recording.

An `example` block holds an input and its output as **one passage**, which is right for a
document and useless as a golden task: a case needs the request in one field and what makes the
answer right in another. The first version passed the whole passage as both, which produces a
case asking a model to reproduce its own expectation — a test that passes by construction, and
worse than no test because it would count towards coverage.

Splitting a stored passage afterwards would be a convention-parser that drifts; inferring the
split with a second model call would put words in the author's mouth on the one surface whose
value is that the words are theirs. So **the interview turn states both halves in the same
call** — two nullable columns on `interview_candidates`, same content, structured, no extra
cost. When the model declines to split, no case is created: an example that does not separate
was not an input/output pair.

Only an accepted `example` from a `worked-example` session becomes a case. Turning every
accepted block into one would fill the lab with guardrails, the same restraint the block
extractor shows by refusing to type a bare code fence as an `example`.

> **The suite tested the wrong gate first, and only running it showed that.** Publishing checks
> R4.5's validation before it checks evals, correctly — form before behaviour. The fixture's
> draft had no frontmatter, so structural-lint raised `missing-description` at high severity,
> `validation.blocked` went true, and **the publish was refused before the eval gate was ever
> consulted**. Both gate assertions were red for a reason that had nothing to do with the thing
> they name, and had the draft happened to validate they would have been green for a reason that
> had nothing to do with it either.
>
> The fix is not just giving the fixture a description. It now **asserts its own precondition** —
> that the draft clears validation — so a suite whose subject is the eval gate fails loudly when
> it cannot reach it, rather than quietly reporting on a different gate. Same family as
> `verify:blocks` going green on an empty table and `verify:embeddings` passing a condition that
> could not fail.
>
> Its cleanup was wrong in the same run and in a way worth naming: `llm_usage.subject_id` is
> `text` and `skill_evals.id` is `uuid`, so the `finally` died on `operator does not exist: text
> = uuid` **after** the assertions — leaving a draft, its cases, its runs and six ledger rows
> behind, quietly inflating the workspace's monthly spend. A cleanup that only runs when
> everything passed is not a cleanup.

> **This makes the schema a hard dependency of publish and of the interview.** `publishDraft`
> reads `skill_evals` and `decideCandidate` selects the two new columns, so both fail loudly
> until migration 0034 is applied — `verify:publish` and `verify:interview` go red with
> `relation does not exist`. Migration-before-code is the normal order and a loud failure is the
> right way round, but it is worth knowing before wondering why two green suites turned red.

### The platform can hold a conversation now, and a conversation needed its own budget (M2)

`src/lib/conversation.ts` · `src/server/billing/conversation.ts` · `src/server/llm/stream.ts`
`pnpm verify:stream` (33 checks, free) · migration 0032

All four existing model call sites are one-shot, and that is what made `assertWithinBudget`
complete: the unit of work and the unit of spend were the same thing. An interview is twenty
calls against the `$5` default org cap, each re-sending the transcript — so **cost grows with
the square of the conversation**, and checked per call the first eighteen turns pass and the
nineteenth refuses, which is the worst place to stop somebody halfway through explaining how
they actually work.

#### The spend decision, made rather than discovered

The plan named three options. **Reservation** loses: holding micro-dollars before spending them
needs a release path, and a conversation abandoned in a closed tab holds budget until something
sweeps it — a sweep that fails takes money from a customer who never spent it. `spend.ts`
already rejected reservation for one call as too much machinery for a bounded overshoot; the
machinery gets worse here. **A turn cap alone** loses harder: turns are not money, and a
transcript that grows every turn makes the tenth call several times the first. That is the
`quality_score` banding mistake again — a gate measured with something that is not the gate.

So: **a per-conversation cap in real money, checked per turn, and on screen from turn one.**
Refusing mid-conversation is unavoidable in the worst case; what makes it acceptable is that
the remaining budget travels with every turn, so it reads as a fuel gauge rather than a wall.
A turn cap exists as well and is labelled as what it is — a bound on transcript growth, not a
budget.

- **No new table.** A conversation's spend is the rows its turns already wrote:
  `sum(cost_micros) where subject_id = <session>`. `llm_usage` carries `subject_type` and
  `subject_id` precisely so a charge traces back to its cause. A counter column would be a
  second source of truth for a number the ledger already holds.
- **The cap is the lesser of its own ceiling and what the org has left**, so it can never
  advertise 50¢ to a workspace with 20¢ — a gauge that lies from turn one is worse than none.
- **Three refusal reasons, not a boolean.** Out of money, out of conversation budget, out of
  turns. Only the first is a billing problem and only the last two are fixed by starting again;
  one flag would send an author round a loop that cannot end.
- **`interview` is its own `llm_purpose`** rather than folded into `builder`, because one
  generation and an N-turn conversation are shapes an operator needs to tell apart.

#### What the seam is actually for, which is not what it was written for

`streamMetered` was built expecting backpressure — nothing pulls, nothing finishes,
`totalUsage` never settles, so metering that hung off the reader would miss every abandoned
turn. **ai@7 does not behave that way.** It drains the model stream eagerly.

> **The first fixture could not have found that out.** It used `simulateReadableStream`, whose
> timer pushes chunks on its own, so it "reproduced" a hang that was the mock's behaviour rather
> than the SDK's. Rebuilt against a genuinely pull-based source, the SDK pulled all six chunks
> with no reader. A mock that self-drives cannot observe backpressure, and a check that cannot
> observe the failure it is about is not evidence — the `aws4fetch` grep, one layer up.

`consumeStream()` therefore stays as a **guard against a dependency changing**, and the comment
says so rather than claiming a fix. `verify:stream` pins the behaviour, so an SDK upgrade that
reintroduces backpressure goes red and names the line that has become critical. The property
that matters either way — an abandoned turn still reaches the ledger — is asserted end to end
against the real `llm_usage` table: read one chunk, walk away, and the row still lands with
full token counts.

The honest limit is stated too: this covers the process continuing to run. A runtime that tears
the invocation down on disconnect can still cut metering off, which is why the route handler
wraps the persistence in `after()`.

`streamText` is called in **one place**, asserted against the source tree — a second call would
be a call with no budget gate and no guaranteed metering, and it would look entirely ordinary.

### Interview mode (Doc 6 RW.4, R5.1, R5.4)

`src/lib/interview.ts` · `src/server/interview/` · `/api/interview/[sessionId]` · migration 0033
`pnpm verify:interview` (19 checks, free — no provider is reached)

A form captures what somebody can already articulate. The knowledge worth writing down is the
other kind: the exception they always make, the thing they check first because of something
that went wrong two years ago. Nobody types that into a box labelled "purpose", because it does
not occur to them that it is unusual.

**Every turn emits typed candidate blocks**, and that is what makes this part of the workbench
rather than a chat window beside it. One structured call does both jobs — asks the next question
and turns the last answer into blocks — streamed through `streamMeteredObject` so the question
appears while the blocks are still being written. Two calls would have been twice the money and
the second would have had to re-read the transcript to know what the first was driving at.

**R5.1 and R5.4 are one motion.** Accepting a suggestion puts it on the draft; rejecting does
not. There is no thumbs-up control anywhere, because a rating asked for its own sake is the
control everybody ignores — here the feedback *is* the action the author already wanted to take,
and ignoring it means not getting the block.

- **Five prompts, not one interviewer with five moods.** Each names its own failure mode, which
  is the part a shared instruction cannot carry: walkthrough drifts into summary, contrastive
  probing into flattery, exception mining into hypotheticals. `verify:interview` asserts each
  one does — and caught `worked-example` shipping without one.
- **Targets bias, they do not restrict.** The turn schema accepts the whole block vocabulary,
  because the most valuable thing an author says is routinely not what the question was after.
- **Accepting writes through `setDraftBlocks`**, like every other change to a draft, and lands
  in the revision history under its own reason. Nothing in the interview touches
  `skill_drafts.body`.
- **Appended, never placed.** The archetype's typical position is a median over a corpus, not a
  statement about this document; C1b's reorder is one drag away and the author knows where it
  goes.
- **A rejected candidate is kept.** Doc 6 §7 expects some of this to be pruned on evidence, and
  a technique whose candidates are always rejected is only prunable if the rejections exist.
  Same reasoning as a rejected flag and a rejected takedown.
- **`accepted` and `edited` stay apart.** Both put a block on the draft and they are opposite
  signals about the *suggestion*; collapsing them would flatter the one number that says whether
  this is working. The original text is kept beside the author's version, so how far a kept
  suggestion had to move is measurable.
- **Decided once**, or an accept appends the same block twice and every accept-rate query
  double-counts.

> **A route handler, and the third documented exception.** A server action returns a
> serialisable value; this returns a stream. Same reason the download route and the MCP endpoint
> are handlers. It imports no database module, no query builder and no driver — everything is in
> `src/server/interview/**`. Budget refusals come back as **402 with the state attached**, not
> 500, for the reason the rate limiter returns 429: a client that cannot tell "out of money"
> from "broken" either retries forever or gives up on a soft failure.

**Nothing feeds the miner.** Each decision writes a structured `events` row carrying the
technique, the block type and how far an edit moved it — everything a later consumer needs, and
consumed by nothing yet. Creation telemetry earned its influence over `mineArchetype` by
accumulating enough signal to survive R6.5's trimming; this has none, and wiring a near-empty
input into the thing that scaffolds every future draft is how a loop poisons itself.

**The one part that waits on D1.** RW.4 says a captured worked example should emit an eval case.
`skill_evals` does not exist yet, so it does not — but an accepted `example` block from a
`worked-example` session is identifiable from its candidate row, so D1 can find them
retroactively rather than needing them re-captured.

> **It is also the honest test of the question the miner left open.** `anti-example` clears its
> threshold in zero of thirteen categories and measures −5 in `review`, contradicting Doc 6 §2 —
> but the detector fires on markers, so it may be measuring house style rather than absent
> knowledge. Exception mining elicits failure-mode knowledge directly. If authors produce it
> readily while the corpus measurement stays negative, **the detector is what is wrong**, and
> the pruning decision can finally be made on evidence. That comparison needs sessions to have
> happened; the data it needs is now being collected.

### A draft is typed blocks now, and the body is a render (plan step C1 / C1b)

`src/lib/draft-blocks.ts` · `src/server/builder/blocks.ts` · migrations 0031–0032
`pnpm verify:draft-blocks` (49 checks, free) · `/build` and `/build/[id]`

M1's keystone. Interview mode, Distill, shared blocks, agent-side creation and
improve-an-existing-skill all operate on the *parts* of a document, and each is coherent over
a list of typed spans and incoherent over a body string — a "revision" to a string is a
character diff nobody reads as a decision, and "accept this suggestion" is a
search-and-replace. Building any of them first would have meant rewriting it here.

`draft_blocks` holds type, order and the author's text, with `null` type staying valid content
exactly as it does in the corpus. `skill_drafts.body` **stays a plain string and becomes a
render**, written by exactly one code path.

> **Publish-back and export must not learn about blocks, and they have not.** They take a
> body, hand it to the real validator (R6.1) and the real archive builder (R4.4), and that is
> precisely what makes those two requirements true — a block-aware export would be a second
> definition of "servable", on the axis where drift is a legal problem rather than a bug.
> `verify:draft-blocks` asserts both files import nothing from the block layer.

#### The extractor's spans do not cover the document, and that is the bug this step nearly shipped

The plan says importing a body needs no new detector, because `blockDeviations` already runs
`extractStructure` over a draft body and types it. True about the *typing* and incomplete
about the reassembly: the extractor treats a **heading as a boundary, not a block** — right,
since the heading is already the fingerprint's own unit and emitting it twice would
double-count every section — and it skips horizontal rules as punctuation.

So concatenating its spans returns a document with **every heading gone**. Nothing errors. The
author opens their draft and it is no longer theirs.

`tileDraftBody` merges the typed spans with `headingSpans` and reads the gaps between them
straight out of the body. `headingSpans` is collected by **the same segmenter**, in the same
walk, so fence handling — the `#` inside a code block — has one implementation rather than
two. The corpus output is byte-identical: `verify:blocks` still passes 55/55, including its
check that a stored span matches what the extractor produces today.

The suite **reproduces the loss before asserting the fix**, so the fixture is proven able to
fail. Then: every non-blank line survives in order, re-importing the render is a no-op, and
the render re-types to what was stored — that last one matters because the archetype panel on
the same page re-extracts the rendered body, and a render that segmented differently would
describe a document the author is not reading.

#### One writer, asserted against the source tree

"Blocks are the source and the body is derived" is only true while one code path writes the
column. Clean data cannot demonstrate that — a second writer produces a body that renders
differently from the blocks beside it and nothing fails, exactly as `verify:dedup` stayed green
through a total ingestion outage by asserting the data was tidy instead of attempting the
insert that caused the bug. So the check walks `src/` and `scripts/` for a `.set({ … body: … })`
on `skillDrafts` and allows one file, **and then asserts that file was found**, because a
whitelist matching nothing would pass for the wrong reason.

#### Ids survive a replace, and that is what makes R4.7 possible

Rows are replaced rather than upserted — `block_order` is unique per draft, so renumbering in
place collides with itself mid-statement; the same delete-and-reinsert `skill_blocks` uses for
a different reason. **The caller's ids are carried through**, which looked like a courtesy for
a later feature and turned out to be the whole of R4.7: a revision diff matches on id, so a
block that only moved is recognisably the same block.

R4.7 had been open since the builder shipped and the blocker was never storage. Over a body
string a revision is a character diff, and `moved` has no expression in one at all — it shows
up as a deletion and an unrelated insertion far away. The suite reproduces that too: comparing
rendered text calls a single reorder a three-line rewrite when nothing was written.

`draft_revisions` is a jsonb snapshot rather than a second table shaped like the first, because
it is read whole and never queried by block. **No body is stored beside the blocks** — that
would reintroduce inside the history the exact drift the live table exists to prevent. SELECT
and INSERT policies and **no UPDATE or DELETE**: history the application can rewrite is not
history, same posture as `llm_usage`. Restoring goes *forward*, appending a revision rather
than truncating to the one restored from, because a history that deletes itself when used is
one nobody dares click.

#### `ready` means the document says something

R4.6's simplified path — "scaffold it, I will write it" — creates a draft from the archetype's
block grammar as **empty typed blocks**, no model call, so it works in a workspace that has
spent its cap. Nothing is pre-filled, which is the same refusal the block library and C1b's
"add one here" both make: most of this corpus is `attribution_required`, and seeding a draft
with a stranger's prose would launder an attribution obligation into a document carrying none.

That created a gap worth naming. An empty scaffold renders to a list of headings, which *is* a
body — so `if (!draft.body)` would have let somebody publish an outline. `ready` is therefore
set on **content**: at least one non-heading block with something in it. Publishing checks the
status server-side, not only in the UI, because a server action is a POST endpoint.

### Similarity for authors: what already exists (Doc 2 R3.6)

`similarToText` in `analytics/embeddings-run.ts` · `components/builder/similar-skills.tsx`
`pnpm verify:embeddings` (26 checks) · `pnpm embeddings --similar "…"`

The dedup data has existed for months and nothing showed it to the person about to add to the
pile. An author who can see that four near-identical skills already exist will narrow their
scope or stop, and both beat a fifth copy. It reads the A6 vectors, so it needed pgvector
first.

Working, measured: *"review a django project for slow ORM queries before release"* returns
`django-perf-review` at **0.64** with quality 100, then `django-access-review` at 0.57. That
is the requirement doing its job at 21% index coverage.

#### Placed where the author can still act on it

Next to the purpose field, not after the sections step. Shown at the end it is a fact about
work already done; shown beside the purpose it is a decision — narrow the scope, or stop. Fed
the name and purpose together, because a name alone is too short to embed usefully and a
purpose alone often omits the subject.

**On demand, not as you type.** Every check is one metered embedding call. A fraction of a
cent is nothing; a fraction of a cent per keystroke is a bill nobody predicted, so it is a
button — the same posture as `taxonomy --sample`.

**It never tells the author to stop.** A high score is information, not a verdict: a Django
review and a Rails review *should* look alike, and a builder refusing on a cosine score would
be wrong often and unarguable when it was.

#### Coverage travels with every answer

`SimilarityReport` carries `coveragePercent` and a `reliable` flag, and the caveat is printed
**above** the results. During the backfill, "nothing similar exists" and "nothing comparable
has been embedded yet" are the same short list and opposite conclusions — and an author who
reads the first when the second is true writes the duplicate this feature exists to prevent.
`RELIABLE_COVERAGE` is 90 rather than 100, because the last few per cent are skills arriving
faster than the backfill and a threshold that never settles means the feature is never on.

> **Two checks that passed for the wrong reason, in one step.**
>
> The short-query guard was in the builder action only. `verify:embeddings` then showed
> `similarToText("x")` returning **ten** arbitrary neighbours and billing for the embedding —
> noise has nearest neighbours and they look confident. Worse, the check that should have
> caught it read `hits.length === 0 || coveragePercent === coverage`, whose right-hand side is
> trivially true. **A check whose condition cannot fail is not a check.** The guard moved into
> `similarToText`, where the CLI gets it too, and the assertion now names the number.
>
> The category labels defaulted to the `function` axis, because `skills.categories` stores
> bare values with no prefix. It looked right and rendered *"Review & critique ·
> software-engineering"* — the function label resolved and every domain one fell through
> `labelFor`'s pass-through as a raw slug. Both axes are tried now, with `isValidCategory`
> asked rather than inferring resolution from the answer looking different.

### Public writes: recorded, never enforced (R2.5, R1.8, R7.5)

`src/lib/flags.ts` · `src/server/curation/flags.ts` · `src/app/(public)/actions.ts` · migration 0030
`pnpm verify:flags` (28 checks, free) · Settings → **Flags** · `/submit`

Three things a person with no account may now do: report a problem with a skill, suggest a
repository, file a takedown notice. All three were admin-only, which meant **the only route
from a reader to the quarantine queue was an analyzer bump** — closing the oldest unclosed
P0 in the validation half.

#### Nothing enforces on arrival, and that is the whole design

A flag lands `received`. A submission lands as an ordinary discovery candidate. A notice lands
`received` and unenforced. None of them hides, re-scores or withholds anything until a named
curator decides, with their reasoning on the row.

> That is not caution. **Enforcing on arrival means anybody who can fill in a form can un-list
> a competitor** — the failure every takedown regime is criticised for, and why `takedowns`
> already separates recording from deciding. The temptation is strongest for the security
> reasons: surely a credible exfiltration report should hide the skill immediately? That is
> exactly the reason an attacker would file `malicious` first.

**Only an upheld flag records an outcome signal.** `flagged` is adverse (R6.3) and adverse
outcomes bar `battle-tested` — so a received flag that counted would let a two-line form
defeat a month of clean downloads and a passing re-validation. `verify:flags` asserts a
received flag produces no signal, leaves the skill's status alone, and does not queue the
version.

**Upholding queues re-validation rather than quarantining.** The analyzers decide. A curator
forcing a `quarantined` status would produce a withheld skill with **no verdict row explaining
why**, which is the gap R7.1 exists to close and which the reader of that page would see as an
unexplained refusal.

#### The write limiter fails closed, inverting the read scopes

`publicWrite` is five a minute, thirty an hour — tight, because nobody legitimately files
twenty reports a minute. And when the limiter's own settings cannot be read it **refuses**,
where the MCP read scopes allow.

> A read limiter that fails closed takes the public registry dark because a counter table
> blinked, over data that is public and read-only. A write limiter that fails open lets an
> unbounded flood into a queue a human works through, and the settings coming back does not
> undo it.
>
> **That policy lives in `fallbackDecision` because the first version was untestable.** The
> check broke `DATABASE_URL` and called `consume`, expecting the settings read to fail — it
> did not, because the pool is a module singleton built on first import, so the assignment
> arrived too late and the limiter answered normally. A check that passed for the wrong
> reason, and the exact ESM-ordering trap `verify:spend` had already documented. A policy that
> cannot be tested where it is written belongs somewhere it can.

#### Smaller decisions worth keeping

- **Server actions, not route handlers.** An action *is* a POST endpoint, so this is the other
  side of the no-database-in-API-routes rule rather than a way round it: handlers are for wire
  protocols and file downloads, and anything returning a value to our own bundle is an action.
- **`autoPromote: false`** is the only difference from the admin submission path, and
  `submit.ts` was written expecting it. The large-repository gate therefore still applies: an
  admin typing a name is the human look it requires, a stranger pasting a URL is not.
- **A duplicate report reads as success.** Saying "you already flagged this today" confirms an
  earlier submission landed, which is a small oracle and a needless one.
- **Native `<details>`, not a dialog.** No dialog primitive is vendored, and a `<details>`
  needs no focus trap and degrades to a usable form with JavaScript still loading — which
  matters when the reader has just found a credential in a skill.
- **Both forms sit quietly at the bottom of the page.** A prominent Report button fills a
  queue with idle clicks; somebody who has actually found something will look for it.
- **A stale flag is labelled, not hidden.** "This is broken" is a claim about content, and a
  re-sync may have replaced it — a curator who cannot tell a stale report from a live one will
  eventually re-quarantine a fixed skill.
- **The reporter's note is untrusted input**, rendered as text and never as markup, never fed
  to a model without the R7.3 fence. It is free text from a stranger about content that may
  itself be adversarial.
- **A rejected flag is kept.** A refused report is still a report that was made, which is the
  half of this that protects the platform — the same reasoning as a rejected takedown.

### Outcome telemetry: the other half of the loop (Doc 2 R6.3)

`src/lib/outcomes.ts` · `src/server/analytics/outcomes.ts` · migration 0029
`pnpm verify:outcomes` (28 checks, free — probes then rolls back) · Settings → **Loop**

Creation telemetry (R6.2) records what happened *while* a skill was written. It had been
running for months and it is only half a loop: everything the platform said about "what good
looks like" was a statement about **what the corpus contains** — prevalence, lift, the shape
of other people's documents — and never about what worked.

These are the other half. A download is a consumer choosing the skill. A re-validation that
still passes is the skill holding up against analyzers that did not exist when it was
written. A quarantine on re-validation is the strongest negative signal the platform has,
because nothing about it is an opinion.

#### Recorded where it cannot be forgotten

`exportSkill` takes a required `channel`, so the web route and the MCP tool cannot diverge on
what counts as a download — the same argument R6.1 makes for publish-back calling the real
validator rather than a lighter equivalent. `null` is an explicit third option for
`verify:export` and internal "could this be served" checks, because counting those would make
the corpus look busier than it is.

Only a **successful** export counts. A refusal is not a download, and counting one would make
licence-blocked skills the most popular things in the corpus.

Only a **re**-validation counts. A first validation is the gate that decides whether a skill
is in the registry at all, so counting it would hand every skill a free positive on the day it
arrived. `VersionRow` gained a `priorStatus` field for exactly this and nothing else.

#### The dedup identifies nobody

A daily-rotating HMAC of the caller key, truncated. It exists so one reader taking one skill
twice in a day counts once (R6.5's dedup-per-identity), and the **day is inside the HMAC
key**, so yesterday's digests cannot be recomputed from today's salt — unlinkability is a
property of the construction rather than a promise about how we query. No IP, user agent,
session or token id is stored, and `verify:outcomes` checks the *schema* for those column
names rather than trusting today's data.

Counting rows **is** the deduplicated count: the unique index is
`(skill_version_id, kind, day, caller_digest)`, so there is no counter to drift and no
application logic a second call site could forget.

> **With no salt configured it undercounts, and that is the chosen direction.** Every caller
> collides, so a skill records at most one download a day. A signal that can move published
> guidance must never fail towards counting *more*.

#### The recorder is silent, so something else has to be loud

`recordOutcome` swallows its own failures — a reader must not get a 500 because a telemetry
insert hit a cold compute, the same posture the heartbeat took. That posture has already cost
this project once: `recordUsage` swallowed an RLS refusal, builder spend was never metered,
and the failure was a log line nobody read.

> The defence is not to remove the swallow. `verify:outcomes` **writes through the real
> recorder and reads the row back**, then repeats the same call and asserts the count did not
> move. A hand-written insert would have proved the table works and nothing about whether the
> function meant to fill it does, which is the entire failure mode of a swallow-everything
> recorder.

#### Battle-tested is now earnable, and still not grantable

A4 shipped the tier with no branch and asserted nothing could hold it. That assertion was easy
to satisfy and proved nothing about whether the tier would ever work. It now reads deduplicated
downloads, a re-validation that passed, an age floor and zero adverse outcomes ever — every
threshold from `BATTLE_TESTED` rather than written into the SQL, because a trust tier whose
advertised and enforced criteria are two separate literals will eventually mean something other
than what the FAQ says.

`verify:outcomes` synthesises the evidence, asserts the derivation flips to `battle-tested`,
adds one adverse signal and asserts it flips back — then rolls all of it back. It is still
impossible to *declare*: the enum cannot express the value, so the only route is the evidence.

One subquery with `count(*) filter`, not four correlated counts, because this expression is
meant to be usable in a listing and four per row is how `/skills` came to take 2.3 seconds.

> **The branch shipped broken for ten minutes, and the checker is what found it.** Drizzle
> renders a JS array in a `sql` template as a **row constructor** — `($2, $3)` — which is what
> `in` takes and is not an array, so `= any(($2, $3))` is a type error Postgres reports as
> *"op ANY/ALL (array) requires array on right side"*. Every skill page would have 500'd.
>
> It was caught because `verify:lifecycle` **compiles** `lifecycleExpression()` rather than
> holding a copy of it — the fix made an hour earlier for a different reason. A copied CASE
> would have gone on testing the old three-branch rule and passing.

#### What it honestly cannot do yet

**Attribution has almost no data, and every surface says so.** Only skills published through
the builder carry archetype lineage, so `archetype_category` is NULL for the entire ingested
corpus. R6.3's *collection* half is useful immediately — it is what makes battle-tested
earnable and RK.7 possible — but its *attribution* half waits on builder volume. The loop
panel prints attributed-of-total beside the headline rather than the headline alone, because
"the loop is closed" is otherwise a claim nobody checked.

**Nothing feeds the miner.** Creation telemetry earned that right by accumulating enough
signal to survive R6.5's trimming; this has not. Wiring a near-empty input into the thing that
scaffolds every future draft is how a loop poisons itself with its own noise.

`flagged` needs a reader route (R2.5, plan step B2) and `eval-delta` needs the Eval Lab
(plan step D3). Both are named in the vocabulary so a dashboard can say "not collected"
rather than having no concept of them.

> **This step makes the schema a hard dependency of the running app.** `getSkillBySlug`
> selects the lifecycle derivation, which now reads `outcome_signals` — so the skill page
> errors until migration 0029 is applied. Migration-before-code is the normal order and this
> is a loud failure rather than a silent wrong answer, which is the right way round, but it
> is worth knowing before wondering why a page broke.

### pgvector, unparked — and it costs eight cents, not ten dollars

`src/lib/llm-pricing.ts` · `src/server/analytics/embeddings.ts` · migration 0028
`pnpm embeddings --status | --sample N | --backfill N` · `pnpm verify:embeddings` (23 checks, **free**)

Four features were blocked on vector similarity and none can be built on text matching:
R3.6's "twelve similar skills exist, here is how yours differs", RW.8's trigger-collision
check, RK.3's contradiction detection, RK.5's clustering of what the corpus does not cover.
It was parked until the corpus stopped moving — sound reasoning, since vectors built over a
half-ingested corpus get rebuilt — and ingestion finished, so the condition is met.

#### What is embedded: the claim, not the document

Name, summary and category labels. **No body**, and that is a decision.

Every waiting consumer matches on *what a skill claims to do*. R3.6 compares claims. RW.8
tests what triggers a skill, which **is** its description — embedding the body would blur the
exact thing that lab measures. RK.5 clusters queries against what the corpus offers. The
description is what an agent reads to decide, so it is what similarity should run over.

The practical half agrees. The body lives in object storage, so including it means re-reading
~48,000 bundles from an EU bucket — the block extraction just measured that at about 2.5
hours — for a marginal gain on an axis nobody asked for. Summary-only makes the backfill
minutes and drops the bill from a planned **$5–10 to about $0.08**. The plan's estimate was
written assuming a 1,000-token body window; the estimate was not wrong, the design changed.

> Measured after the first 5,020: **84 tokens a skill**, against the 60 the status line
> assumed — a 40% understate on the one number an operator reads before deciding to run it.
> The projection now divides the tokens already charged by the rows already embedded, and
> says which of the two it is doing. The constant survives only for the first run.

Stated limitation: two skills with equally bland summaries will not separate. If body-level
similarity is ever wanted — E2's guardrail contradiction detection is the likely first caller
— the answer is a **second embedder over blocks**, a different unit with its own composition,
not a wider window on this one.

#### The price entry is the whole story of this step

> `rateFor` falls back to `UNKNOWN_MODEL_RATE`, deliberately the most expensive rate known.
> Without an entry for the embedding model, a 29-million-token backfill would have been
> charged at **$14.40 against a real $0.058** — and on a bigger corpus the $50 platform cap
> would have refused the run partway through, looking like a budget problem rather than a
> missing table row. The rate came from the gateway catalogue endpoint that
> `llm-pricing.ts` names as the source of truth, **fetched, not remembered**: 26 embedding
> models with live prices, of which this is the cheapest at $0.02/MTok. `outputPerMTok: 0`
> is a fact about the model, not a placeholder — a vector is not billed as output.
>
> The second trap is one line away. `embedMany` reports **`usage.tokens`**, not
> `usage.inputTokens`. Reading the latter returns `undefined` and meters the entire run as
> free — the exact shape of the `recordUsage` bug that made builder spend invisible and left
> RC.2 satisfied on paper only. `verify:embeddings` asserts no stored vector has zero
> recorded tokens, because that is what the mistake looks like from the outside.

#### Versioned on the composition, not just the model

`EMBEDDER_VERSION` carries model, width **and** the field list. A model or width change fails
loudly at the insert because the column is fixed-width; only a composition change can produce
vectors that sit beside older ones, look current, and cannot be compared. Same failure
`classifier_version` exists to prevent. `input_hash` is the cheap half: a version whose
composed input is byte-identical is skipped even under `--force`, because paying twice for
the same string is never what force meant.

#### Two decisions that go the opposite way from their neighbours

**Batches run sequentially**, where bundle reads run six-wide. Different bottleneck: those are
latency-bound against object storage; this is a metered call behind a shared budget, and
parallel batches all pass `assertWithinBudget` before any cost is recorded — which breaks the
one-call overshoot bound that RC.2's before-check/after-ledger order depends on.

**HNSW, not IVFFlat.** IVFFlat needs a training pass over existing rows, so its index is
degraded until somebody remembers to rebuild it after a backfill. HNSW is correct from the
first insert. Costlier to build; 48k rows is nowhere near where that matters.

**Canonical only.** Near-duplicate variants are by definition the rows nearest to something
already embedded, so including them fills every similarity result with clones and multiplies
the bill by the cluster sizes.

#### Not scheduled, against my own plan

The plan said "an incremental hook in the pipeline". It does not get one. CLAUDE.md's standing
rule is that **nothing costing money is scheduled**, and while that rule's own condition
("once RC.2's spend caps exist") is now satisfied, switching it on is a deliberate decision
like archetype refresh shipping OFF — not a side effect of building the thing. The resumable
selector serves the same need with no configuration: `pnpm embeddings --backfill` picks up
whatever is new and charges nothing for what is already done.

`CREATE EXTENSION IF NOT EXISTS vector` is the one hand-written line in migration 0028 — the
same documented exception migration 0017 took for `pg_trgm`, because an extension is not
expressible in a Drizzle schema and `vector(1536)` is not a type until it exists. Availability
was checked against the live database (pgvector 0.8.6, present, uninstalled) rather than
assumed.

### Entitlements: the guarantee is a refusal, not a flag (Doc 2 RC.1)

`src/lib/plans.ts` · `src/server/dal/entitlements.ts` · migration 0027 · Settings → **Plans**
`pnpm verify:entitlements` (24 checks, free — the gate half needs no database)

RC.1's substance is not "support tiers". It is that the free-tier trust surfaces — verdicts,
provenance, quarantine status, capability surface, quality score, licence posture, registry
reads, permitted downloads — **cannot be paywalled by configuration**. Doc 1 is blunter:
paywalling the per-skill verdict would destroy the platform's reason to exist.

**So the gate throws when handed one of those keys.** `hasEntitlement("…", "verdicts")` does
not return `true` — it raises `UngateableError`.

> **Returning `true` was the obvious implementation and it is the wrong one.** A gate that
> always passes still *exists*: the call site reads as a paywall, a reviewer sees a check
> being made, and the day somebody tidies the special case away the paywall switches on.
> Refusing the question means the wrong call site cannot be written and still run — the
> failure lands on the developer writing it, in development, which is the only place it is
> cheap. Two error types, not one, because "customer should upgrade" and "we were about to
> break a standing commitment" must not be caught by the same `catch`.

`verify:entitlements` asserts every one of the eight keys throws through **both** entry
points, and that no key appears in both vocabularies — a key that was gateable and
ungateable at once would resolve whichever way two `if`s happened to be ordered.

#### Its own table, against my own plan

The plan for this step said "a plan column on the organisation". That was wrong.
`organization` is Better Auth's table, and the standing rule here is that those shapes get
re-derived with `getAuthTables()` whenever a plugin is added or the version moves — a
hand-added column is exactly what that would not know about. A commercial fact does not
belong in an auth vendor's schema, and RC.4 will want a billing customer id and a period end
that belong there even less.

**An absent row means `free`**, which is what makes a fresh deployment gate nothing. The
alternative — a row written at organisation creation — means a half-finished bootstrap leaves
workspaces with no plan, and "no plan" would have to mean something.

**Expiry is read at the gate, never swept by a job.** A task that downgrades lapsed plans is
a task that can fail, and its failure mode is a customer keeping what they stopped paying
for. Same reasoning as the lifecycle's derived `stale`.

#### The schema's third split policy

SELECT open to `app_runtime`, INSERT and UPDATE org-scoped. Forced by two reads that are
cross-organisation by definition: an operator listing every workspace's plan, and resolving
the plan behind an MCP token *before* any org scope is set — the same shape that made
`mcp_tokens.SELECT` open, where the lookup is how the organisation is discovered. Safe
**because of the column list**: a plan name, an admin's note, who granted it, when it lapses.
Add a column carrying customer data and the policy becomes wrong.

**No DELETE policy.** A downgrade is `plan = 'free'` — a row an auditor can read and an event
naming who did it. Deleting reaches the same outcome with no trace, because an absent row
already means free. Same argument as `platform_settings`.

> A near-miss caught before it shipped: `planFor` was first wrapped in `withExplicitOrgScope`
> against an all-scopes policy, which would have made every unscoped caller see no row and
> therefore read as `free`. A permissions failure disguised as data — precisely the shape
> `validatePending` shipped with when RLS answered its unscoped read with `org_id IS NULL`
> only.

#### One live consumer, and it needed no new branch

`rate-limits.ts` was written anticipating this and said so: the tier-selecting path was built
and tested while always answering `free`, "so when entitlements land the limiter needs no new
branch." It did not. The MCP route now resolves the token's plan and picks `mcpPaid` or
`mcpFree`, and the paid numbers that were stored and unreachable are reachable.

`hasEntitlement`, not `requireEntitlement`, at that call site: a free caller is not doing
anything wrong and gets the free window. Throwing would turn the absence of a subscription
into a failed request.

**Every other feature key names something that does not exist yet** — Distill (C4), the Eval
Lab (D), MCP authoring (RM.3) — because each was blocked on there being an entitlement to
check. Nothing served today is gated, so the free-tier guarantee now holds by construction
*and* by mechanism. The Plans panel says which features are live rather than offering a
control that silently does nothing, and lists the free-forever surfaces on the one screen
where somebody would go looking for a way to sell them.

### The lifecycle is mostly derived, so nobody can grant it (Doc 6 RK.1)

`src/lib/lifecycle.ts` · `src/server/skills/lifecycle.ts` · migration 0026 · `pnpm lifecycle`
`pnpm verify:lifecycle` (32 checks, free — probes then rolls back)

`skills.status` answers **may we serve this**. The lifecycle answers a question static
scanning cannot reach: **how proven is this, and is it still current.** A skill can pass
every analyzer and be three years stale; it can be replaced by something better and still be
perfectly valid. Two axes, two columns — fold them together and a routine re-sync eventually
overwrites a curator's deprecation notice, which is the "recorded then ignored" shape this
file has already recorded three times.

#### Only two states are storable, and that is the enforcement

Doc 6 is specific: battle-tested is **earned from evidence**, stale is **detected, not
declared**. The honest way to hold a system to that is to leave it nowhere to cheat. So the
enum has exactly two values — `deprecated` and `superseded` — and everything else is computed
at read time. Nobody can hand a skill a battle-tested badge, because there is no column to
write one into, and **Postgres rejects the value** rather than a code review catching it.

`verify:lifecycle` asserts that at both levels: the TypeScript guard refuses it, and
`select 'battle-tested'::lifecycle_declaration` must throw.

#### Battle-tested has no branch at all

It needs installs, eval deltas and age without incident — R6.3, plan step B1 — and none of
that is collected. The tempting shortcut is a proxy from what *is* available: call anything
old and high-scoring battle-tested. That is **exactly** the mistake the archetype miner made
when it banded on `quality_score` and confidently reported that good review skills are
single-file with no code examples. So the tier is named in the vocabulary, absent from the
derivation, and reported as zero with the reason attached — because a table of zeros with no
explanation is how `archetypes --blocks` came to look like a finding.

`draft` is also absent, deliberately: a row in `skills` exists because something was
published, so the value could never occur, and a vocabulary carrying a state nothing can hold
is lying about the space it describes.

#### One derivation, in SQL, and the checker compiles it rather than copying it

`lifecycleExpression()` is the only place the state is computed — a badge on a skill page and
a filter in a listing have to agree by construction. It cannot be a generated column, tempting
as that looks next to `search_vector`: the `stale` branch compares `review_by` against
`now()`, and a generated column requires an IMMUTABLE expression.

> **The verification shipped with the bug it exists to prevent, for about ten minutes.** The
> first draft pasted the CASE into the check and asserted in a comment that it was "kept
> identical on purpose". A checker holding its own copy of a rule verifies that the copy is
> self-consistent and stops noticing the day the real one moves — the `taxonomy --status`
> mistake exactly. It now renders `lifecycleExpression()` through Drizzle's own dialect, so
> changing the derivation changes what is tested.

Precedence: not indexed → **no state at all** (the trust surface answers for those, and a
second badge would compete with the withdrawal notice) → `superseded` → `deprecated` →
`stale` → `validated`. A human's assertion outranks a measurement because it carries intent;
`superseded` outranks `deprecated` because it comes with somewhere else to go.

#### Two operations, because one of them was quietly lying

`declareLifecycle` and `setReviewDate` are separate functions. They were one, and the seam
leaked immediately: setting a review date on an undeclared skill passed `declaration: null`,
which wrote an audit row reading **`lifecycle.cleared`** and wiped the existing note on the
way past. An operator who set a date would have found the log saying they had lifted a
deprecation. An audit trail may be incomplete; it may not be confidently wrong.

A review date is governance, not a state — it is an *input* the `stale` branch reads.

#### Refusals worth knowing

- **Superseded needs a replacement.** A state that tells a reader to go elsewhere and cannot
  say where is a worse `deprecated`, and should have been that instead.
- **The replacement must be `indexed`**, or the page sends a reader to a dead end after
  telling them to go there. Resolved by a **live join**, like archetype exemplars, so a
  replacement quarantined since the declaration stops being linked rather than going on
  being recommended.
- **The replacement must be in the same workspace**, or a public page leaks the existence of
  a private skill — RC.5 arriving through an unexpected door.
- **Nothing supersedes itself.**

Deprecation does **not** block the download. It is a curator's advice, the licence still
permits it, and the bytes are still what was validated — refusing would be us converting
advice into a prohibition nobody asked for. `withdrawn` is the case that refuses, and it
already does.

> **Two more paths that had never been run, both found by running them.** The rollback probe
> exercises the *derivation* with raw SQL, so it proved nothing about `declareLifecycle`
> itself — and driving the CLI for real turned up both: `scripts/lifecycle.mts` imported
> `skills` from the schema **barrel**, which a native-ESM `.mts` cannot see named exports
> through (every other script already imports the concrete file; this one was the exception),
> and `--review-by <slug> clear` ran `new Date("clear")` and was rejected by its own date
> guard, so the one option the usage string advertised had never once worked.
>
> The audit trail is now checked for the shape of the bug it used to have: a
> `lifecycle.cleared` row carrying a `reviewBy` in its payload is the precise signature of a
> review-date change reported as a lifted deprecation, and nothing else produces it.

Declared through `pnpm lifecycle` rather than a settings panel, for the same reason `submit`
and `promote` are CLIs: it is a curator operation on one named skill and there is no per-skill
admin page. The panel belongs with E1's freshness nudges — one that can set a review date but
cannot yet tell anyone it has passed is furniture.

### Activation cost: what a skill costs the agent that loads it (Doc 6 RW.9)

`src/lib/tokens.ts` · `components/registry/activation-cost.tsx` · `pnpm verify:tokens` (17 checks, free)

Every other number in the registry describes the document. This one describes what the
document *does to you*: a skill is paid for in context tokens on **every activation**, the
whole marker enters the conversation each time it fires, and nothing in the ecosystem tells
an author what theirs costs. RW.9's eventual pitch — *this skill costs 4.2K tokens; here is a
1.9K version with identical eval results* — needs the first half measured before the second
can be built, and D4 is the second half.

Shown on the skill page beside quality, and on a draft in `/build` **through the same
component**, because the question an author actually has is "is mine bigger than the ones I
copied from?" and two components would eventually round differently.

**It says `est.` everywhere, and that label is load-bearing.** Four characters per token for
prose, three for code, because identifiers and punctuation split more often. That is not a
tokenizer: Claude's is not public, a BPE library would be a dependency this project has not
taken, and an exact count per skill means an API call per skill. So the figure is honest for
*comparing* two documents — this draft against that draft, an original against a compressed
rewrite, which is exactly what D4 needs — and dishonest as a claim about someone's context
window. A number that looks measured and is not is worse than no number, because a reader who
later finds the gap stops trusting the surfaces that *are* exact.

**The bands are derived from the validator's own size budget, not invented.**
`MAX_BODY_BYTES` (40,000) and `DISCLOSURE_HINT_BYTES` (15,000) moved out of
`structural-lint.ts` into the leaf module with their values unchanged — the same refactor
`SEVERITY_WEIGHTS` had when the FAQ needed it. The lint already had an opinion about a
document being too big, so a cost display with *its own* thresholds would eventually tell an
author their skill is fine while the validator flagged it as an oversized monolith. Values
identical means no behaviour change and therefore no analyzer version bump; `validate:verify`
stayed at 22/22.

> **The estimator's divisors are pinned by a test.** Not a tautology: it is the only thing
> between "someone improves the estimator" and 51,000 stored `token_estimate` values quietly
> meaning something else while `structures --status` still reports them as current. The check
> names the fix in its own failure message — bump `EXTRACTOR_VERSION` and re-extract.

**Absent, never zero.** A version with no fingerprint at the current extractor version
renders no badge at all. During a re-extract campaign that is most of the corpus, and "0
tokens" is a claim about the skill where silence is a claim about us. The null check lives in
the page rather than only in the badge, because `Explain` wraps its child in a link and a
link wrapping nothing is an invisible tab stop.

First measurement, over the 510 extracted so far: **median 1.2K tokens, mean 1.8K** — and
that sample is not random, so read it as a first look rather than a corpus figure.

### Doc 6's central bet, measured: blocks discriminate about twice as well as sections

`pnpm archetypes --blocks` · full corpus, 50,965 fingerprints at extractor 2.0.0

The whole RW.x programme rests on one claim: section *presence* has stopped separating good
skills from the rest, and the functional units **inside** sections still do. That is testable,
and it has now been tested on complete coverage rather than on a sample.

**It holds.** Corpus-wide, over 13 banded categories:

| block type | clears its threshold in | best lift | median |
|---|---|---|---|
| reference-pointer | 11 of 13 | +29 | **+18** |
| decision-rule | 10 of 13 | +26 | **+21** |
| output-spec | 6 of 13 | +23 | +14 |
| guardrail | 6 of 13 | +21 | +10 |
| tool-contract | 4 of 13 | +20 | +7 |

The number to compare against is the one in the section above: **the best *section* lift
across the three largest categories is +10.** Block lift reaches +20 in `review` alone and
+29 corpus-wide, with two types clearing the bar in ten or eleven categories out of thirteen.

`review`, the largest category at 3,748 structures (407 curated / 3,341 other), keeps five
block types where section presence produced a thin skeleton:

```
decision-rule      75% / 55%   +20     3.3 vs 2.4 per skill
reference-pointer  47% / 33%   +14     1.3 vs 0.7
tool-contract      54% / 43%   +11     3.0 vs 2.4
procedure          89% / 80%    +9     4.3 vs 3.2
output-spec        65% / 57%    +8     2.3 vs 1.9
```

The density column is the part a heading count could never reach. Everyone writes a
procedure — 89% against 80% is barely a finding — but curated skills write **4.3 of them
against 3.2**, and carry nearly twice as many reference pointers. "Has a steps section" and
"breaks the work into four checkable steps and links to two bundled files" are different
claims, and only one of them is advice.

#### Two of the eleven types earn nothing, and one contradicts Doc 6 directly

`anti-example` clears the threshold in **zero** categories, median **−3**, and in `review` it
is outright negative: 32% of curated structures against 37% of the rest. Doc 6 calls it
*"the rarest and most valuable block type"*. The corpus disagrees.

`stance` is also 0 of 13, and in `review` sits at 5% against 11% — below the prevalence floor
entirely.

> **Before pruning either, the detector is a live suspect for one of them.** The
> `anti-example` cues are markers: ❌, "common mistakes", "what not to do". Long-tail skills
> — many of them model-generated — reach for that punctuation constantly; a vendor writing
> formal documentation expresses the same knowledge as prose and matches nothing. So the
> negative lift may be measuring **house style rather than the presence of failure-mode
> knowledge**, which is a detector limitation and not a finding about skills. That is exactly
> the shape of the `quality_score` banding mistake: a confident number measuring the wrong
> thing.
>
> `stance` reads differently and is probably real. *"You are an expert…"* is a hallmark of
> prompt-shaped generated skills, which sit overwhelmingly in the weak band, and a vendor
> documenting its own product has no need for persona theatre.
>
> **So: `stance` is a candidate for pruning under Doc 6 §7. `anti-example` is unresolved and
> should not be pruned on this evidence** — the honest next step is reading fifty curated
> skills and asking whether the knowledge is absent or merely unmarked.

> **The warning printed above this result was wrong, and that is worth recording.** The
> coverage query left-joined `skill_structures` and counted rows — correct for exactly as long
> as each version had one fingerprint. After the 2.0.0 re-extract every version has two, so
> the denominator doubled and the command announced **50% coverage at the moment it was
> complete**, telling the reader to distrust a solid result. A `count(*) filter` over a
> fan-out join gets the numerator right and the denominator wrong, so the ratio is off by
> exactly the fan-out and looks plausible throughout. Both halves are subqueries over versions
> now.

### Blocks: the grain below the heading (Doc 6 RW.1 / RW.2)

`src/lib/block-types.ts` · `src/server/analytics/blocks.ts` · migration 0024 · extractor **2.0.0**
`pnpm verify:blocks` (34 checks, free) · `pnpm structures --probe N` · `pnpm archetypes --blocks`

The section above is the reason this exists. Section *presence* stopped separating the bands
at full coverage — everyone writes `steps` now — so the archetype's discriminating power had
already moved once, from headings to bundle shape. Doc 6's bet is that it moved *inward* too:
one `steps` section routinely holds a procedure, two guardrails and a tool contract, and an
archetype that can only say "this category has a steps section" cannot tell an author which
of those four the good skills in their category carry.

So each section is now segmented into **typed spans**: eleven types — trigger, stance,
procedure, decision rule, guardrail, example, anti-example, tool contract, output spec,
glossary, reference pointer. Pure rules, no model, no network, free to re-run.

**The vocabulary is canonical here, not mirrored.** `section-roles.ts` duplicates its keys
from a `server-only` module and says so; that duplication is a standing hazard, so
`block-types.ts` is a leaf module with no imports and the `server-only` detector imports
*it*. One copy, and the direction of dependency makes a second one impossible.

#### Structure beats lexicon, and it is load-bearing

The rule table is ordered in four tiers: the passage's own syntax, then the section the
author declared, then structure inside the passage, then wording. The third tier over the
fourth is the whole reason it is a table and not a switch.

> **Procedures are written in modal verbs.** "Run the dry run first, you must never skip it."
> Put a lexical guardrail rule above the ordered-list rule and **every numbered procedure in
> the corpus becomes a guardrail** — measured on the first pass, it did exactly that, and the
> resulting archetype would have told authors that good skills in every category are made of
> prohibitions. A run later the same trap caught `anti-example`, because a numbered procedure
> containing "don't skip past errors" was typed as a failure mode. An ordered list is a
> procedure; an unordered list of nevers is a guardrail; the shape decides and the words break
> the tie. `verify:blocks` **proves the trap is still armed** — it asserts the guardrail cue
> genuinely fires on the fixture — before asserting the fix, because a case that no longer
> reproduces the bug is a case that passes for the wrong reason.

Tier two sits *above* tier three deliberately: a passage under "When to use this" is a trigger
because its author said so by writing that heading, and an author's own labelling beats our
reading of the shape inside it.

#### A row is a coordinate, never content

`skill_blocks` stores `[start_char, end_char)` into the marker body and no text. That is what
lets a block library exist for a `metadata_only` skill without mirroring a byte of it: the
coordinate is meaningless without the bundle, and the bundle is behind the licence gate. A
fragment resolves **live**, exactly as an archetype exemplar does, and inherits the same
property — a skill withdrawn since extraction stops being quotable immediately rather than
living on in a stored copy.

**This table may never grow a column holding body text.** Same
safe-because-of-the-column-list argument as the `builder_signals` read policy, and
`verify:blocks` asserts it against `information_schema` rather than against today's data,
because clean data says nothing about the next migration. A marker phrase in the fixture body
proves the serialised blocks do not carry it.

Character offsets, not bytes, and named `startChar`/`endChar` so the unit is not something
anyone has to infer. `marker_path` is pinned on the fingerprint row so a later change to the
marker-detection regex cannot silently re-point a million stored spans at a different file.

#### Blocks are replaced, not upserted

The row *count* changes when the rules change, so there is no key an upsert could target — a
document that segmented into 30 blocks and now segments into 28 would keep two stale rows for
ever, and those two are the ones a library query would rank highest one day and fail to
resolve the next. Delete-then-insert, scoped to the extractor version, inside the same
transaction as the fingerprint so `block_types` and the block rows cannot disagree.

#### What the dry run found, and why it exists

`pnpm structures --probe N` runs the real detector over real bundles and **writes nothing**.
It is the reason three defects were fixed before a single row was written, and none of them
were visible to the fixtures:

- **Anti-example markers bled across whole sections.** The first version read the previous
  paragraph and the heading, so one "Watch for these redirections" turned every block beneath
  it into a failure mode, including "Used across every skill in this repo, defined only here."
  Cues now test the passage's **own text**, and the tier-two heading rule
  (`anti-example:mistakes-section`) carries the legitimate case — under "## Anti-patterns"
  every passage really is one, because the author said so.
- **`do not`, `never do` and `avoid` were in the anti-example label cue.** They are how a
  *guardrail* is phrased, so every prohibition list came back as a failure mode. The label
  convention is punctuation — "❌ Wrong:", "**Bad** —" — so that is what is required now.
  Anti-example fell from 37% of skills to 23%, which is a believable number for the type Doc 6
  calls the rarest.
- **A horizontal rule was a block.** Under an "## Anti-patterns" heading a bare `---` was
  duly typed as an anti-example. Punctuation is not content, and a library that offered `---`
  as a fragment would be worse than one with a hole in it.

> **A number that disagreed with what it claimed to measure, again.** The probe first reported
> 2,360 unclassified blocks sitting in the **preamble** — above the first heading — which is
> impossible, and sent me looking for an attribution bug that did not exist. `parentRole` is
> null in *two* cases: above the first heading, and under a heading the role rules did not
> recognise, which is most of the corpus's headings and the correct outcome there. The label
> collapsed three states into two. Attribution was fine; the diagnostic was lying.

#### The bare code fence stays unclassified, deliberately

~570 fenced blocks per 300 skills carry no shell language, no CLI runner and no example cue.
Typing them `example` would classify most of them and would be a lie with consequences: Doc 6
sells an example block as "convertible straight into an eval case" (RW.6), and a YAML config
fence is not an input/output pair. "We found 204 examples" is a claim RW.6 can stand on; "we
found 700" collapses the first time somebody generates eval cases from them. Same lesson as
the taxonomy's no-description rule — **a threshold tuned to clear the queue buys queue depth
with correctness.**

More generally, `type` is nullable and stays that way. Doc 6 §7 names over-structuring as this
programme's risk, and a taxonomy that types every passage is not recognising, it is guessing.
The unclassified share is reported rather than hidden, because it is the honest measure of
whether this vocabulary earns its keep — and `verify:blocks` fails if it ever reaches zero.

Measured over 300 real bundles: **36 blocks per skill, 41% classified**, no rule taking more
than 6.8% of the mass, and every one of the eleven types present in between 7% and 69% of
skills. The unclassified mass is where it should be — 3,014 paragraphs under *topical*
headings, where only a lexical cue could ever fire.

> **`verify:blocks` went green on an empty table, twice, in the same file.** The coverage
> check read `blocks === 0 || (share > 20 && share < 100)` and reported **ok** against zero
> rows; four vocabulary checks did the same, because `count(*) where value not in vocabulary`
> is trivially zero with nothing to count. That is `verify:dedup` staying green through a
> total ingestion outage, rebuilt from scratch. Schema assertions ("no free-text column", "a
> policy exists") are true or false on an empty table and still run; every data assertion is
> now gated on there being rows and prints **skip** with the command that would fix it.
>
> **And a third time, in the command that matters most.** `archetypes --blocks` filtered to
> banded categories and printed its table regardless, so at 1% re-extraction it rendered
> eleven rows of `0/0  0  0` — which reads as *blocks carry no signal* when the truth was
> *nothing has been measured yet*. Same output, opposite conclusions, on the one command
> whose job is to decide whether the rest of the Doc 6 programme gets built. It now refuses:
> it prints coverage, the band sizes per category, which threshold is unmet, and the command
> that fixes it. Same posture as `taxonomy --compare`, which exits non-zero rather than print
> a confident wrong answer about a $130 decision.
>
> `structures --blocks` carries the milder version of the same warning, because extraction
> has no `ORDER BY` and a partial run is not a random sample: on the first 510 skills
> `anti-example` read **52%** against **23%** on a randomised probe of 300. Same detector,
> different sample.
>
> The same run produced the other half of the lesson. The free-text check was a hand-written
> allowlist of column names and it failed on `kind` — a closed enum nobody had listed.
> Extending the list would have been the cheap fix and the wrong one, because the next column
> needs a human to remember again. It now allows only identifiers and columns *declared* to
> hold a closed vocabulary, and a second check proves each declaration against the data, with
> the rule vocabulary derived from the rule table (`BLOCK_RULES = RULES.map(...)`) so it
> cannot drift from what actually fires.

#### Mining v1 measures; it does not publish

`blocks-mine.ts` imports `representatives()` and the lift threshold from `archetype.ts` rather
than reimplementing them. That is not tidiness: this codebase has twice produced a number that
measured a gate with something that was not the gate, and the near-proxy replacement for the
first one agreed to within a point and would have swapped a *visible* contradiction for an
invisible one. Block lift and section lift are only comparable if the bands, the reduction to
one representative per structure, and the significance rule are literally the same code.

`pnpm archetypes --blocks` reports lift per block type per category, and `--category X` shows
every type measured — kept or rejected, with the threshold it was judged against and why.
Nothing reaches the published skeleton yet: the moment a block lift lands in `/build`, every
draft in the product is scaffolded from it, and that deserves its own miner version and its own
changelog rather than arriving as a side effect of extraction.

> **The extractor bump makes every stored fingerprint stale, and that is not a UI problem
> here.** `EXTRACTOR_VERSION` is the re-extract selector, so at 2.0.0 the corpus reads as zero
> fingerprinted until `pnpm structures --extract` catches up — roughly 50k bundles. Checked
> rather than assumed: `/archetypes`, `/build` and the skill pages read the stored
> `archetypes` table and are unaffected, and `structureSummary` is CLI-only, so nothing
> renders the blank screen that a bumped taxonomy version once produced. What *is* affected
> until re-extraction finishes is a fresh mine, the diversity report and `--status`, all of
> which report an explicit count rather than an empty state.

### Archetypes band on source trust, not on the quality score

R3.2 is implemented in `analytics/archetype.ts`. The method is a **contrast**: every element
carries a `lift` — prevalence in the strong band minus the weak band — because a section
present in 90% of good skills *and* 90% of weak ones is not advice. Near-zero lift is
dropped however common; negative lift becomes an anti-pattern for free. Evidence is counted
in **distinct structures**, never skills, so one generator's 300 clones are one data point.

**The bands come from who published the skill, not from `quality_score`.** That reversal is
the most important thing in this file.

Banding on quality quartiles produced a confident, wrong archetype: *good review skills are
single-file with no code examples.* The score is bounded at 100, most skills have no findings
at all, and thousands sit at exactly 100 — so the "top quartile" is really "whichever 100s
sorting picked", and anything that systematically stops a skill reaching 100 shows up as an
anti-pattern. Every multi-file bundle collects an `orphaned-resources` note (severity `info`,
one point, 2,293 occurrences), so **no multi-file skill can score 100**. Meanwhile the
average runs the other way: 4+ file skills average 92.4 against 86.2 for single-file.

Zeroing the info weight removes that bias and makes the ceiling worse. Adding completeness
signals to the score would be circular — the miner would discover that good skills have the
features we scored them for.

So the strong band is the **curated seed allow-list** (`SEED_REPOS`, derived not copied) and
the weak band is everything else: an independent judgement about craft, made by people,
before any analyzer ran. A proxy, and honest about being one.

Every sign flipped:

| element | quality bands | source trust |
|---|---|---|
| More than one file | −62 avoid | **+40 do** |
| Bundles assets | −18 avoid | **+32 do** |
| Offloads into `references/` | −18 avoid | **+26 do** |
| Contains code examples | −39 avoid | **+23 do** |

The confirming detail: curated skills average **95** on our quality score against **97** for
the rest. The professionally-built ones score *worse* on our own metric, which is the
clearest possible statement that the metric was measuring the wrong thing.

`MINER_VERSION` is 2.2.0 and every earlier row is kept — archetypes are append-only, so the
broken generation stays visible as history rather than being quietly overwritten.

#### A proxy has to be maintained, and this one silently went stale (2026-09-03)

`SEED_REPOS` *is* the strong band. That makes it the one policy constant in this codebase
where **not editing it is itself a decision**, and nobody was making it deliberately.

Written in August against a 16k corpus it held 18 repos. Sync then finished at 49,258
indexed skills and those 18 supplied **865 of them — 1.8%**. Everything else was the weak
band by construction. Meanwhile the skills.sh reconciliation had delivered the first-party
vendor repos the list exists to name: **27 of them holding 1,987 indexed skills, 2.3× the
entire strong band, all banded as untrusted** — NVIDIA, Google, Adobe, Salesforce,
Microsoft, OpenAI, Grafana, Elastic, HashiCorp.

The decisive tell was one organisation on **both sides** of the contrast: `getsentry/skills`
curated and `getsentry/sentry-for-ai` not; `anthropics/skills` curated and
`anthropics/knowledge-work-plugins` — ten times larger — not. A contrast like that is not
measuring craft. It is measuring which URLs somebody typed in August, and every `lift` in
v5 was diluted by exactly that.

**The rule now written into the file: first-party — the GitHub organisation owns the product
the skills document.** Checkable from the org rather than a quality opinion, and the same
judgement the vendor section already made. Stars are not a criterion: `celigo/ai` has three
and `sumsub/agent-skills` six, and both are a vendor documenting its own product for agents.
Popularity gets no vote here for the same reason it gets none in R2.9's search ranking.
Notable individuals (`antfu`, `addyosmani`, `chrisbanes`) are deliberately **not** in — that
is the high-signal-community class, a different rule, and mixing the two in one pass would
leave the band with no statable definition.

51 repositories added, **all 51 verified against the GitHub tree API first**, none from
memory — the same standard `seeds.ts` already set after three of its hand-written entries
turned out to be 404s.

> **The band lookup was also case-sensitive, and the corpus holds 15 repos twice.** GitHub
> treats `owner/repo` case-insensitively; our `sources` table does not. `NVIDIA/skills` and
> `nvidia/skills` are **one repository** stored as two rows with 268 and 99 indexed skills,
> so an exact-match lookup would have credited one and banded its twin as untrusted — a
> silent half-count of a curated source, which is precisely the drift the comment above
> `CURATED_SOURCES` exists to prevent. Both sides are lower-cased now. The 15 duplicate
> source rows are a separate ingestion bug and are still open.

Result: strong band **865 → 3,586** indexed skills (1.8% → 7.3%), and re-mining stored v6
for ten categories (v3 for `edit-refactor` and `transform-data`, v5 for `research`). All
twelve still clear the evidence gate; `automate-browser` still fails it at 37 structures
against a floor of 50, unchanged. Every new row carries R3.4 attribution — verified, not
assumed.

**`edit-refactor` is the clearest single gain.** It was the thin one-section skeleton this
file has flagged twice — only `purpose`, at +25. With the band corrected it mines four
sections (`how-it-works`, `steps`, `examples` added). The other twelve roles had been
measured all along; what was missing was a strong band big enough to separate them.

> **The taxonomy still bounds all of this.** These v6 rows are mined from the same 4,101
> labelled skills as v5 — **8% of the corpus**, down from ~25% at the last audit, because
> sync tripled the corpus and labelling did not move. v6−v5 isolates the band fix. The next
> re-mine, after labelling, isolates the evidence. Keeping those two changes in separate
> versions is the only way either number means anything.

### Measure structural diversity, not source concentration

**Read this before drawing any conclusion from a corpus-wide number.**

The first instrument for corpus health was share-of-corpus per source, and it flagged
`mohitagw15856/pm-claude-skills` at 89%. The number was alarming and the instrument was
wrong. Source concentration is a *proxy*, and it misreads in both directions:

| Source | Skills | Distinct shapes | Diversity |
|---|---|---|---|
| `aws/agent-toolkit-for-aws` | 120 | 104 | **87%** — large *and* varied |
| `google/adk-kotlin` | 15 | 1 | **7%** — tiny *and* one skeleton |
| `mohitagw15856/pm-claude-skills` | 2,185 | 340 | **16%** — the real generator |

A share cap penalises AWS and ignores adk-kotlin. What actually damages the foundry is
**structural monoculture** — many skills sharing one document skeleton. An archetype mined
from one skeleton repeated 331 times describes a generator, not a convention, and it looks
like a universal truth when you count skills.

So the number on the wall is `templateClusters()` in `src/server/analytics/templates.ts`:
the **structural signature** (ordered section-role sequence + coarse size band) of every
fingerprint, grouped. Corpus-wide it reports distinct structures, diversity percent, and how
many skills sit inside clusters of 10+.

**This is not near-duplicate detection.** `analytics/dedupe.ts` compares *text* with MinHash
and correctly refuses to cluster template siblings — they have genuinely different names,
descriptions and subject matter. They share a *shape*, not content. Two orthogonal axes, two
measurements; conflating them either discards real skills or hides a real problem.

**Volume is an asset, noise is acceptable input.** The platform is not only a registry — it
needs mass to run categorical and structural analysis against, and a corpus curated down to
pristine sources would have too little to learn from. Nothing is rejected for being large or
repetitive. The place monoculture is *acted* on is archetype weighting: `categoryEvidence()`
counts **distinct structures**, not skills, so R3.2's ≥50 threshold cannot be cleared by one
generator alone. `minStructuralDiversityPercent` in `policy.ts` is a reporting floor, never a
gate.

The long-run fix is balancing high-signal sources against the noisy ones, which is a
market-analysis question — see the discovery section above and the open-web TODO.

### Taxonomy — two axes, because structure follows function

`skill_categories` (migration 0006) carries two independent vocabularies, both in
`src/server/taxonomy/vocabulary.ts`:

- **function** (13) — what the skill *does*: review, generate-document, edit-refactor,
  transform-data, orchestrate, … **Archetypes are mined on this axis.**
- **domain** (29) — what field it serves: marketing, devops-infrastructure, legal, …
  Drives browse and filter.

The split is the load-bearing decision. Structure correlates with function, not domain: a
skill that reviews a contract and one that reviews a pull request share a shape (rubric,
severity levels, output format), while one that writes an HR policy and one that writes a
landing page share a different shape (template, placeholders, examples). Mining per domain
would average a rubric together with a template and yield a skeleton that fits neither.

Nothing in the corpus declares a category — **zero** of 2,531 skills carry a `category` or
`tags` key — so the taxonomy is derived, never read. Curated and closed, after Hugging
Face's `pipeline_tag`; npm keywords are the negative example.

Assignments are multi-label with calibrated confidence. Below `REVIEW_FLOOR` (60) an
assignment is held for a curator instead of being served, and a curator-reviewed row is
never overwritten by a later classifier run — that is what `setWhere: reviewedAt is null`
on the upsert is for. `skills.categories` stays as the denormalised read path and holds
only servable labels at the **current** taxonomy version; `pnpm taxonomy --resync`
recomputes it after a version bump.

### Low-confidence labels were feeding archetype mining

The confidence floor was applied in three places and missing from the three that matter most
for R3.2. `listSkills` filtered on it and `skills.categories` held only servable labels, but
`analytics/archetype.ts` (both `representatives` and `skillTotal`) and
`analytics/templates.ts`'s `categoryEvidence` read **every** assignment — so archetypes were
mined partly from labels the classifier itself had flagged as unreliable.

Measured before the fix: **384 of 4,095** function assignments, and **127 of 601** in
`explain`. A fifth of one category's evidence being guesswork does not blur the claim, it
makes it a claim about a different category.

All three now apply `confidence >= REVIEW_FLOOR or reviewed_at is not null` — the registry's
rule, because the miner and the registry must agree on what a category *contains*. A
curator-reviewed row counts whatever its score: a human already decided.

Effect on the evidence, which is smaller than the input change and says something:
`review` 446 → 402 skills but 258 → 257 structures; `explain` 601 → 474 skills, 307 → 304
structures. **The excluded labels were nearly all on skills that duplicate a shape already
present**, so the gate is unaffected and every category still passes. Nothing needs
re-mining urgently; the next `--mine-all` picks it up.

> A backtick inside a `sql` template literal terminates it. Two of these comments were
> written with `code spans` and produced four `TS1005 ',' expected` errors in a query that
> looked fine. Prose about a query belongs in the JSDoc above it, not in the SQL.

### What is actually in the low-confidence queue

Worth knowing before anyone tries to automate it. Of 1,130 held assignments over 748
distinct skills:

- **None are near-duplicate variants.** `canonical_skill_id is not null` matches zero of
  them, so `analytics/dedupe.ts` has not clustered these — their text genuinely differs.
- **The worst end is repeated non-skills.** In the worst 100 rows there are 64 distinct
  names, and **67 of 100 have a missing or under-40-character summary**: `demo`, `root`,
  `s`, `input-repo`, `Recent Activity` (17 copies), `AGENTS.md` (8). The same *kind* of
  artefact from many repos rather than copies of one file.

So the classifier is not being unsure about skills — it is being asked to categorise things
that are not skills, and correctly refusing.

### The no-description rule, and why it is tiny

`src/server/taxonomy/classifiable.ts`. `pnpm taxonomy --sweep [--dry]`.

**A length threshold does not work, and the measurements are the reason the rule is three
lines instead of one clever one.** Taking the best confidence per skill:

| rule | held skills cleared | **confident skills wrongly dropped** |
|---|---|---|
| summary shorter than 40 chars | 137 | **93** |
| summary shorter than 20 chars | 45 | 11 |
| two words or fewer | 164 | **71** |
| **empty, or a single bare token** | **12** | **2** |

Short is not the same as uninformative: "Django performance code review" is 30 characters
and perfectly classifiable. **The queue is not mostly junk** — that was true of the worst
100 rows sampled by eye, not of the 1,130. Most held rows have ordinary descriptions and the
classifier is unsure for reasons no length test can see.

So the rule catches only what is *structurally* empty, and it cleared **26 assignments
across 13 skills** — 1,130 → 1,104. That is the honest size of this problem. A threshold
tuned to clear the queue would have bought queue depth with correctness.

Three places apply it, and it is **a selector, not a state** — no column, no migration, so a
skill whose description improves upstream becomes eligible again on the next sync:

- **selection**, so the model is never called for a skill with nothing to read (saves the
  call, not just the row);
- **the review queue**, so a row nobody could decide never appears;
- **`remaining`**, which now excludes them and can therefore reach zero. They are reported
  separately as "19 with no description" — one number is work left, the other is a fact
  about the corpus, and adding them together would make the taxonomy look permanently
  unfinished.

Deleted, not marked reviewed: `reviewed_at` is a pin (`setWhere: reviewedAt is null`), so
marking these would freeze a guess and stop a better-described version ever being
classified. Same reasoning as `reviewCategory("reject")`.

> **The remaining 1,104 are not a backlog anyone will clear.** They are already excluded
> from the registry and, since the floor fix above, from archetype mining — which is exactly
> "keep the flag, do not use it for signals". What is left to decide is `REVIEW_FLOOR`
> itself, not the rows.

### The taxonomy keeps no history, so "did the vocabulary change help?" is unanswerable

`pnpm taxonomy --compare` · `--sample N --relabel` · `versionComparison()`

`skill_categories_uq` is **`(skill_id, axis, value)`**. `classifier_version` is a column, not
part of the key — so re-classifying a skill **updates its rows in place** and the previous
version's answer for that label is destroyed. `verdicts` is append-only per
`analyzer_version`; this table deliberately is not, because for *serving* a category only the
current answer matters.

That is fine until someone tries to evaluate a vocabulary change, which is the loop
`classify.ts` describes as the whole point of sampling: read the labels, change a
description, run again. **You cannot measure the "again".**

The trap is that it does not look broken. On a skill that has been re-classified, the rows
still stamped with the old version are exactly the labels the new vocabulary **stopped
assigning** — so comparing them against the new output compares what the new vocabulary
rejected with what it chose, and flatters the new vocabulary by construction.

> **Measured, after 300 skills were relabelled specifically to build a paired set:** 146
> skills carried both versions, holding **159 surviving old rows against 390 new ones**, and
> **113 of the 146 had no surviving old *function* label at all** — impossible for a skill
> that was ever classified, since every classification assigns one. The comparison duly
> reported the domain held rate falling **22.2% → 9.8%**, a strong improvement, entirely
> fabricated by the selection.
>
> The integrity check is now that arithmetic: a paired skill with no prior function label
> proves its prior rows were overwritten, and one is enough, so the threshold is zero.
> `--compare` exits non-zero with the reason instead of printing the numbers. A command that
> prints a confident wrong answer is worse than one that prints nothing — this one exists to
> decide whether to spend ~$130.

**What is measurable without history** is the unpaired rate at which each category is used.
**Per skill, never as a share of labels** — that mistake was made once here and inverted a
conclusion. When labels-per-skill falls, a category can shrink in absolute terms while its
*share* holds steady, because everything around it shrank too: `meta-agent-tooling` went
19.9% → 23.3% → 22.4% by share across three versions and 0.341 → 0.368 → **0.260** per
skill. The share said it was getting worse. It was getting better.

| per skill | 1.1.0 | 1.2.0 | 1.3.0 |
|---|---|---|---|
| domain labels | 1.713 | 1.581 | **1.160** |
| `meta-agent-tooling` | 0.341 | 0.368 | **0.260** |
| `software-engineering` | 0.361 | 0.309 | **0.190** |
| `business-operations` | 0.143 | 0.056 | **0.040** |
| domain held | 10.3% | 11.4% | **2.6%** |
| domain avg confidence | 74 | 73 | **81** |

**The fix, when history is worth it:** add `classifier_version` to the unique key. That costs
a migration plus a decision about which row every read path serves. Not before the bulk run,
because the bulk run is what makes the question expensive.

### The prompt beat the definition, and the axes' own asymmetry proved it

1.2.0 narrowed `meta-agent-tooling` in its description — *"skills that merely happen to be
written for an agent do not belong here"* — and it was used **more**. The description was
never the cause. `SYSTEM` said, two rules later:

> Many skills are general-purpose developer tooling: for those, use the software-engineering
> or meta-agent-tooling domain rather than reaching for a specialised one.

The prompt nominated it as the fallback. **An instruction beats a definition**, and no amount
of rewriting the definition was going to win.

The rationales proved it rather than suggesting it — every low-confidence
`meta-agent-tooling` row named a *different* primary domain in its own reasoning:
`spring-boot-engineer` at 35 said "serving general Java application domain",
`import-infrastructure-as-code` at 35 said "software-engineering is primary domain",
`codebase-documenter` at 35 said "the subject is explaining how application source code
works". The model agreed with the definition and obeyed the instruction anyway. 104 of 163
assignments sat alongside another domain.

**The asymmetry across the two axes is the clincher, and it was sitting in the same prompt.**

| rule | held |
|---|---|
| function — *"Prefer ONE function. A second is for a skill that genuinely performs two distinct kinds of work, not for one that is merely thorough."* | **2.7%** |
| domain — *"Give one to three domains… use software-engineering or meta-agent-tooling rather than reaching for a specialised one."* | **9.8%** |

Same model, same skills, same call. One axis was asked to be decisive and was; the other was
invited to hedge and hedged. 1.3.0 gives the domain rule the function rule's shape and
deletes the fallback sentence.

Result on 100 skills: domain held **11.4% → 2.6%** — 3 held where 13.2 were expected at the
old rate, **3.0 standard deviations**, so not sample noise. Domain confidence 73 → 81.
`meta-agent-tooling` kept every case it should: 18 of its 26 assignments score ≥80 against 51
of 137 before, avg confidence 73 → 82, held 21 → 1. The label is now used confidently or not
at all.

> **1.2.0's description work was not wasted, and this is why both belong.** The boundary
> clauses moved what only they could move — `business-operations` 0.143 → 0.056 per skill
> before the prompt was touched at all. Definitions fix *which* category; instructions fix
> *how many*. Chasing the second with the first is what cost a version.
>
> Bumped to 1.3.0 even though no vocabulary *entry* changed, because `classifier_version`
> has to mean "what decided this label" for R7.2 to hold. A prompt change under a fixed
> version leaves rows from two different classifiers wearing one number.

### Two numbers that disagreed with what they claimed to measure

Both found on 2026-09-03, both in the taxonomy status surfaces, and both the same fault.

**"Archetype-ready" counted skills; the gate counts structures.** `pnpm taxonomy --status`
reported *13 function categories archetype-ready* the moment `automate-browser` crossed 50
confident skills. The miner refused it in the same breath — `gate FAIL (46 distinct
structures, needs 50)`. Both numbers were correct and they answered different questions; the
status command was the more optimistic and the less correct, which is the worst pairing,
because it is the one someone reads to decide whether to mine.

> **The first fix was a near-proxy and would have been worse than the bug.** Wiring the
> status to `templates.ts`'s `categoryEvidence()` produced **45** against the miner's 46 —
> it omits the size band from the signature and skips the `canonical_skill_id` and
> `quality_score` filters. The two errors run in opposite directions and roughly cancel, so
> it passes a glance and fails on any category where they do not. That would have swapped a
> *visible* contradiction for an invisible one.
>
> `gateEvidence()` in `archetype.ts` shares `representatives()`'s `where` clause and its
> signature expression verbatim, and reports 46. Both numbers are now on every status row,
> so the gap is visible rather than being a disagreement between two commands.

`MIN_BAND` is deliberately not applied there: the curated/other split belongs to
`mineArchetype`, and a status line is not worth a full mine per category. A category can
clear the gate and still fail on a thin band, which the miner says when it happens.

**And the same mistake, once more, in the fix.** `readyForArchetype` was computed by
filtering `counts` — which is scoped to `TAXONOMY_VERSION`. Bumping the vocabulary to 1.2.0
therefore reported **0 minable** with twelve categories minable in fact, because the miner
filters on no version at all. It now counts over `evidence`. Measuring the gate with
something that is not the gate, twice in one afternoon.

### A bumped vocabulary must not look like data loss

`TAXONOMY_VERSION` 1.1.0 → 1.2.0 emptied Settings → Taxonomy completely: every coverage card
read *"Nothing classified yet. Run a sample above."* over a table holding **12,944
assignments across 4,701 skills**.

Technically true — `counts` is scoped to the current version and nothing had been labelled at
1.2.0 yet — and operationally a lie. The labels exist, they are still what the registry
serves and what archetype mining reads, and they are queued for re-classification rather
than gone. **A blank screen is the one state an operator cannot tell apart from data loss**,
which is the heartbeat's argument in another costume: a completion record cannot answer "is
it stuck", and an empty table cannot answer "was this wiped".

So `taxonomySummary` also returns the newest superseded version and its per-category
coverage. The panel says what moved and the cards fall back to muted bars labelled with the
old version, instead of an empty state.

- **Newest prior version only, never every prior version summed.** A skill labelled under
  both 1.0.0 and 1.1.0 would be counted twice, and a number nobody can reconcile against the
  table is worse than no number.
- **Structure counts and gate ticks are dropped in the fallback.** Those describe the corpus
  as the miner reads it *today*; hanging them off superseded labels would put two vocabulary
  versions in one row.

> No migration was involved and none was possible: `skill_categories.value` and
> `classifier_version` are plain `text`, and the vocabulary lives only in code behind
> `isValidCategory()`. Worth stating because "the categories changed" sounds like a schema
> change and is not one — the only enum on that table is `axis`.

### The low-confidence queue is paged, because it is 1,130 deep

`reviewQueue` returns a `Paged<QueueItem>` and the card says **"showing 20 of 1,130"**. It
used to take a bare `limit` and return the worst 20 with no total, which made the panel
actively misleading: deciding a row deletes or pins it, the page revalidates, the next-worst
row slides into the freed slot, and the list comes back exactly as long as before. Every
correct decision looked like it had been undone. The only honest signal — "Held for review"
— sat four cards further up.

Three fixes, none of them clever:

- the count is on the card it describes, and the tab now gets the shared `ListControls` and
  `Paginator` like every other paginated list;
- the sort is `confidence, id`. Confidence alone is not a total order — hundreds of rows
  share a score — and deciding rows removes them from the set *while* a curator pages
  through it, which is exactly the workload that exposes an unstable sort;
- the optimistic grey-out is gone. It was wiped by the revalidation it triggered, so it
  flashed and vanished as the list refilled, which read as an undo. The signals that survive
  the refresh are the row disappearing, the toast, and the count going down.

> `pnpm taxonomy --review N` now means **page N**, not N rows. It had to change: `pageWindow`
> clamps to the shared admin page sizes, so `--review 3` was silently printing 10. A flag
> that quietly ignores its argument is worse than one that changes meaning.

**The number is the real finding.** At `REVIEW_FLOOR` 60 the classifier holds roughly a
fifth of its output for a human, and 1,130 rows is not clearable by hand — with ~2,300
skills still unlabelled and sync running, it grows. That is a threshold decision, not a UI
problem, and it belongs with the archetype work after ingestion finishes.

### Structural fingerprints — the evidence archetypes read

`skill_structures` (migration 0006) stores one derived row per skill version: heading tree
with normalised **section roles**, body metrics, resource layout, frontmatter conventions.
Pure rules, no model, no network — so re-extraction is free and `EXTRACTOR_VERSION` is the
re-scan selector, exactly like `verdicts.analyzer_version`.

Roles rather than raw heading strings, because "When to use this", "When to use this skill"
and "Triggers" are three strings and one idea; an archetype built on strings would report
three sections at 33% instead of one at 100%. Rules cover the common headings; the long
tail is genuinely *topical* ("Typography", "Amazon Bedrock") and correctly stays unlabelled
rather than being forced into a role.

Corpus-wide today: 93% of skills are a lone SKILL.md, 4% bundle `scripts/`, 4% bundle
`references/`. Resource-layout archetypes will stay weak until the source mix widens.

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

### ~~Corpus statistics (R8.5)~~ — done, on `/dashboard` **and** on `/`

Skills indexed, validation pass rate, how many are downloadable, quality banded rather than
averaged, licence mix, and freshness against R7.4's 24-hour target. Licence mix gets equal
billing with the count because a result you cannot download is a different thing from one
you can.

Both carry a fifth figure: **archetypes mined**, `12 of 13` categories, and the
distinct-structure count behind them, each with a link through to `/archetypes`. It is the
only figure that is not a fact about the corpus — the other four count what came in, this counts what has been
learned from it, which is the claim the third pillar makes and the one the page could not
previously back with a number. Counted in **distinct structures**, never skills: quoting a
skill count would inflate the evidence by exactly the factor the miner exists to divide out.
The `org_id is null` filter on that query is explicit rather than left to RLS, because the
number lands on the front door and OQ-C2's "private corpora never feed public archetypes"
belongs where someone can see it.

Both surfaces call the same `platformStats()` and **share nothing else**. `/dashboard`
renders it in Cards, which is right inside application chrome; `src/components/landing/
corpus-stats.tsx` renders larger quiet numbers with no borders, because the front door is a
different register. Sharing the query and not the components is the split that matters — the
facts cannot diverge, the framing should.

The panel is written so it can look bad. Pass rate sits beside the quarantine count,
downloads beside the licence mix that caps them, and the headline is qualified by
`sourcesSynced of sources` — ingestion is a fraction done, so the skill count is the size
*so far*, and printing it alone would be true and would overstate what has been reached.
Freshness is stated against the 24-hour target rather than as a bare timestamp, so "6h" can
be read as *inside target* by someone who has never heard of R7.4.

> **A copy bug worth remembering: "only the first two can be downloaded".** Carried from the
> dashboard into the landing page and wrong in both. The licence rows are ordered by count,
> so "the first two" is not a stable claim — and today only *one* servable posture appears
> at all, so the sentence described a list that was not on screen. It now names the two
> `Mirrored` postures by their label, which is true whatever the ordering and however many
> rows exist. Copy that describes a list by position rots the moment the data moves.

Numbers are queried live rather than cached. They are cheap aggregates at this size and a
freshness metric served from a stale cache is self-defeating. `/` is the highest-traffic
page in the product, so it is the first place that will need a cache; the answer then is a
short revalidate on `platformStats`, never a second copy of these numbers.

The dashboard's "your skills" half is queried against the real table and is empty for
everyone, because nothing writes an org-scoped skill until the builder (R4.x) exists. It
fills in on its own when it does.

### ~~Giant repositories need the tarball path~~ — solved with scoped subtrees

`GET /git/trees/{sha}?recursive=1` truncates above ~100k entries, and the connector still
throws rather than proceeding — silence there would mean a partial corpus that looks
complete. What changed is that `includePaths` is now a real way out.

The trick is that it has to be applied **before** the call, not as a filter afterwards.
`listBlobPaths` in `src/server/connectors/github.ts` reads each prefix as its own subtree
via GitHub's `{commit}:{path}` SHA form, so the repository root is never listed. One API
call per prefix instead of one per repo — the trade a curator makes when they name them.

`liferay/liferay-portal` now enumerates: **3,696 skills** under `workspaces/`, where it
previously failed outright. Submitting a repo that is already a source merges the new
include paths onto the existing `sources.config`, which is the case that silently did
nothing at first.

A tarball reader is still the answer for a repository with no usable prefix. Not built, and
no longer urgent.

### Smaller ones

- **GitHub OAuth.** Doc 3 wants it as a login path for identity attribution. Additive —
  the `account` table already carries it.
- **Mail goes out through Nylas** (`src/server/mail/nylas.ts`), which replaced Resend
  entirely — `resend.ts` is gone and `RESEND_API_KEY` is unused, so drop it from `.env`
  and from Vercel. `NYLAS_API_KEY`, `NYLAS_GRANT_ID` and `NYLAS_API_URI` are the three
  variables, and **all three still need adding to Vercel before a deploy**.
  `MAIL_TRANSPORT=console` is pinned locally, so a laptop cannot quietly email people;
  `MAIL_TRANSPORT=nylas` forces a real send for a test.
- **Orphaned organizations.** Deleting a user cascades their `member` row but leaves an
  organization nobody belongs to. `deleteUser` is disabled, so this is not live yet.

### Nylas, and three things the API taught us on the first send

The switch was worth making for one reason: **Nylas sends from a mailbox, not from a
domain.** Resend needs a verified sending domain before it delivers to anyone but the
account owner, which is why sign-in worked for exactly one address. A grant is an
already-authenticated mailbox, so mail leaves under its existing SPF and DKIM — nothing to
verify, and no shared sender quietly reaching one inbox.

`MAIL_FROM` changed meaning with it: it is now an **override**, not the sender. Unset, mail
goes as the grant's mailbox, which is the safe default. Set, it must be a configured
send-as alias or the provider refuses it.

Three findings, each from a real 4xx rather than from reading docs:

1. **`tracking_options` is omitted, never set to false.** A trial account rejects the
   *field itself* — `Tracking options are not allowed for trial accounts` — whatever the
   values are, so `{ opens: false }` fails the send outright. Absence says the same thing
   on every plan. We do not want open or link tracking on a passcode anyway: it rewrites
   the message with a pixel and redirect URLs.
2. **No `Idempotency-Key`.** The first version hashed one from recipient, purpose and code
   to stop a retry sending a duplicate. Nylas remembers the key, so two identical 6-digit
   codes to the same address collide about once in a million sends — and on collision it
   **delivers nothing, silently**, to someone waiting to sign in. A random key per call is
   unique by construction and provides no idempotency at all, so there is no middle
   ground. What it guarded is hypothetical too: Better Auth swallows the throw and does
   not retry. A duplicate code is a far better failure than no code.
3. **The `MAIL_FROM` hint in the error is conditional.** It fired on every failure at
   first, so the very first real error — about tracking options — blamed a correctly
   configured sender and pointed at the wrong file.

> **There is no plain-text alternative any more.** The v3 send endpoint takes a single
> `body` with an `is_plaintext` flag: HTML *or* text, never multipart. `otpText` was
> removed rather than kept as decoration. That makes one property of the template
> load-bearing rather than cosmetic — **the code must stay real text in the markup**,
> letter-spaced digits in a styled element, never an image and never a CSS background, so
> a stripped-HTML client or a screen reader still yields a readable code. `templates.ts`
> says so where someone would otherwise "improve" it.

Verified end to end: `MAIL_TRANSPORT=nylas pnpm mail:check --send <you@example.com>` sends
through the same `sendOtpEmail` that Better Auth calls, and logs the `request_id` — which
is what the Nylas dashboard is searched by, because a 200 means Nylas accepted the message,
not that the provider delivered it.

### A failed send can no longer look like a sent one

`pnpm verify:otp` (4 checks). The bug was not ours and could not be fixed where it happened.
Better Auth hands `sendVerificationOTP` to `runInBackgroundOrAwait`, which — with no
`advanced.backgroundTasks.handler` configured — does exactly this:

```js
try { await promise } catch (e) { logger.error("Failed to run background task:", e) }
```

So the send **is** awaited and its outcome exists by the time the response is built. What
was missing was a channel: the throw was logged, the endpoint answered 200, and the form
advanced to the code step saying "Code sent to you@example.com" to someone who would wait
for ever. The only record was in a server log, which is the one place the person waiting
cannot look.

- `src/server/auth/send-failures.ts` is the channel — a keyed map, written by the transport
  wrapper and read back by the caller. AsyncLocalStorage would be the obvious answer and is
  unavailable: Better Auth owns the route, so there is nowhere to open a scope around it.
- **`since` is the safety property.** A reader only accepts a failure recorded *after* it
  started its own call, so a stale error cannot be reported against an attempt that
  succeeded — which would erode trust in the message exactly as much as the false success
  did. Entries are consumed on read and expire on their own.
- The sign-in form now calls `requestOtpAction` instead of
  `authClient.emailOtp.sendVerificationOtp`, because that client call *cannot fail*. The
  action wraps `auth.api.sendVerificationOTP` — the same endpoint, same rate limiting, same
  OTP storage, headers forwarded — and reads the recorded failure back.

> `verify:otp` pins Better Auth's swallow as an **external behaviour**, deliberately. If an
> upgrade ever propagates the throw, that check goes red and the workaround can be deleted
> rather than quietly carried for years.

Module-level state is a real limitation and is only correct because the write and the read
happen inside the *same request*. Nothing may ever read it from a different one.

### Neon retries, and the half of the idea that is dangerous

`src/server/db/retry.ts`, wrapped around the pool in `db/index.ts`. `pnpm verify:db-retry`
(11 checks, no database and no network — the risk in a retry is entirely in what it decides
to do again, and that is pure logic).

Neon suspends an idle compute and wakes it on the next connection, so a cold start is normal
behaviour rather than an incident, and Neon documents backoff with jitter as required.

**"Retry the query" is one word away from "run the write twice."** `ECONNRESET` can mean the
socket died before the statement was sent, or after the server received it. Retrying the
second case double-applies a write, silently, under load. So failures are split by what they
*prove*, and the split is enforced by where the retry happens:

| phase | what it may retry | why |
|---|---|---|
| `connect` | any connection-class failure | nothing has been sent |
| `query` | only *establishment* failures | anything else may have interrupted a live statement |

Wrapping the pool rather than the DAL is what makes it complete: Drizzle sends ordinary
statements through `pool.query` and takes a client from `pool.connect` for transactions, so
those two methods are every path in. A retry in the DAL would have covered the DAL and
missed ingest, analytics and every script.

**Deliberately never retried:** `40001` and `40P01` are the textbook retryables and are
excluded, because both mean the statement *ran* and its transaction rolled back — the
correct unit is the whole transaction, and retrying one statement would re-issue it into a
transaction Postgres has already aborted. `08007` is excluded for the sharper version of the
same reason: it says nobody knows whether the commit landed.

### The crash a retry could never have caught

A 60-pass ingestion run died at pass 26 with `read ETIMEDOUT`, thrown from
`Client._handleErrorEvent`. **No retry, `try`/`catch` or promise handler could have stopped
it**, because it was not a rejected promise — it was an EventEmitter emitting `error` with
nothing listening, which throws and takes the process with it. Worth stating plainly: the
backoff work above does not cover this and never would have.

The cause is an asymmetry in `pg` that is easy to miss:

| client state | `error` listener | safe? |
|---|---|---|
| idle in the pool | `pg-pool` attaches `idleListener` | yes — *if the pool itself has an `error` listener* |
| checked out by `pool.query` | `pg-pool` attaches `client.once("error", …)` | yes |
| checked out by `pool.connect()` | **nothing** | **no** |

That last row is every `db.transaction()`, because Drizzle takes a client from `connect()`
and holds it for the callback. And `Client._handleErrorEvent` ends with an *unconditional*
`this.emit("error", err)` — it fires even after `_errorAllQueries` has already rejected the
in-flight query, so a short transaction is exposed just as much as a long one.

Three parts to the fix, in `db/index.ts` and `db/client-guard.ts`:

- **`keepAlive: true`** (`pg` defaults it off). The pipeline spends minutes inside one
  GitHub fetch with no database traffic; a NAT on the path drops the silent socket and the
  next read fails. Keepalive probes stop the connection going unobserved.
- **`pool.on("error")`**, which is required rather than tidy — an emit with no listener
  throws, so a pool without a handler turns any blip on an idle connection into an exit.
- **A guard listener on every client from `connect()`**, removed on release so nothing
  accumulates per checkout. It only logs, and that is correct: the error has already been
  delivered where it matters — `_errorAllQueries` rejects any in-flight query, and
  `_queryable = false` makes the next statement reject — so the transaction fails as a
  rejected promise, which the calling code already handles. The event is a second delivery
  of the same fact, and the only thing to do with it is not die.

Not crashing is the whole fix. Per-skill error handling in `syncSource` and stage isolation
in the pipeline already survive one failed transaction; what they could not survive was the
process going away underneath them.

> `verify:db-retry` reproduces the crash before asserting the fix — a bare EventEmitter is
> emitted at and must throw. Without that first check, the guarded case would pass even if
> the fixture had stopped reproducing the bug.

## Commands

Day-to-day pipeline operation, health checks and "is it stuck" live in
**`specs/pipeline-commands.md`** — the operator reference. This is the short list.

```
pnpm dev            # http://localhost:3000
pnpm build
pnpm lint
pnpm typecheck       # runs `next typegen` first — see below
pnpm db:generate | db:migrate | db:studio
pnpm db:verify-rls  # after ANY schema change that adds an org-scoped table

# Pipeline, each bounded and resumable
pnpm pipeline --status               # is it stuck? one line, no ps/lsof needed
pnpm pipeline                        # sync → validate → fingerprint → signatures → cluster
                                     # (also runs on a 10-minute cron in production)
pnpm pipeline --loop 40 --skip-sync  # catch the derived stages up
pnpm rescan --status | --run 300     # R2.12 campaigns; free, rules only
pnpm crawl | promote | sync | validate | duplicates   # the individual stages
pnpm seed --status | --repos | --lists    # curated discovery (Doc 4 §4 steps 1-2)
pnpm promote --reapply --enrich 300 --decide  # judge discovery candidates; --reapply is NOT default
pnpm submit <repo-url|owner/name> [--include workspaces/,packages/]
pnpm validate --consistency --limit 10   # R2.3 audit — COSTS MONEY, capped at 100/run
pnpm structures --extract 500        # structural fingerprints + blocks — free, no model
pnpm structures --probe 250          # block detection, DRY: reads bundles, writes nothing
pnpm structures --blocks             # stored block coverage (Doc 6 RW.1)
pnpm structures --probe 400 --tools  # tool references and decision rules, DRY, from real bundles (Doc 7 P0)
pnpm structures --tools              # the stored table, after the 2.1.0 re-extract
pnpm archetypes --blocks             # does the block grain discriminate? (RW.2) — free
pnpm blocks --library review         # read real fragments per block type (RW.3) — free
pnpm blocks --library plan --type reference-pointer --wider
pnpm taxonomy --sample 20            # categories — COSTS MONEY, capped at 100/run
pnpm taxonomy --status | --review | --resync
pnpm verify:lists | verify:revocation | verify:export | verify:takedown | verify:publish
pnpm verify:telemetry
pnpm verify:otp | verify:db-retry        # both free, no network, no database
pnpm verify:http-deadline | verify:rate-limit   # free; both reproduce the bug first
pnpm verify:dedup                        # repo identity folds case; free, probes then rolls back
pnpm verify:taxonomy | verify:archetypes # vocabulary and mined guidance; both free
pnpm verify:models                       # a model id is a setting, priced and audited; free
pnpm verify:search                       # index path and latency at corpus size; free
pnpm verify:blocks | verify:lifecycle | verify:outcomes | verify:flags   # all free
pnpm verify:draft-blocks                 # a draft is blocks, the body is a render; free
pnpm verify:stream | verify:interview    # conversation budget, and RW.4; both free
pnpm verify:evals                        # Skill CI: regression gate, staleness, probes; free
pnpm verify:trigger                      # RW.8 precision, recall, collisions; free
pnpm verify:trigger --live               # adds the collision round trip — COSTS A LITTLE
pnpm verify:matrix                       # RW.7 with/without deltas, and eval-delta; free
pnpm verify:optimise                     # RW.9 compression, verified before offered; free
pnpm verify:impact                       # RK.7 impact analytics, and honest zeros; free
pnpm verify:freshness                    # RK.2 review dates and link rot; free
pnpm verify:demand                       # RK.5 demand signals and the publish floor; free
pnpm verify:relations                    # RK.3 the graph, and what it refuses to store; free
pnpm verify:relations --live             # 3 controls proving the detector fires — ~$0.002
pnpm relations --status                  # stored edges; free
pnpm relations --conflicts 20            # mine guardrail contradictions — COSTS MONEY
pnpm verify:distill                      # RW.5 tool output is not the user speaking; free
pnpm verify:shared                       # RK.4 a convention is synced, never substituted; free
pnpm verify:mcp-usage                    # RC.3 the agent surface is accounted for; free
pnpm verify:billing                      # RC.4 a late delivery cannot downgrade a customer; free
pnpm verify:mcp-create                   # RM.3 an agent creates a draft, never publishes; free
pnpm verify:api                          # R8.6/R3.7/R8.3 metadata, never bodies; free
pnpm verify:watch                        # R8.7 the feed resolves versions to skills; free
pnpm verify:campaigns                    # RK.8 progress is derived, never stored; free
pnpm verify:parameters                   # RD.1–RD.3 parameters, rules, coverage that says which zero; free
pnpm verify:tool-refs                    # RD.6 tool tokens: the naive reading fails first; free
pnpm verify:improve                      # R5.6 a fork carries its licence; free, no network
pnpm verify:scope                        # RW.10/RW.11 scope and disclosure; free, no network
pnpm scope --status                      # coverage first, then the finding; free
pnpm scope --run 200                     # analyse a slice — COSTS MONEY (~a cent)
pnpm scope --skill <slug>                # one document, printed — COSTS A FRACTION OF A CENT
pnpm scope --calibrate 60                # give separation two reference points — ~$0.002
pnpm verify:maintainers                  # RK.6 endorsement counts only while standing does; free
pnpm maintainers --status                # who maintains what, and which categories have nobody
pnpm maintainers --grant <email> function review --by <you@example.com>
pnpm links --status | --check 200        # external link rot; free, bounded, polite
pnpm verify:tree                         # would a fresh clone build this? free, offline
pnpm db:audit                            # is the derived data current? one command, free
pnpm verify:blocks                       # block taxonomy and span invariants; free
pnpm verify:tokens                       # activation cost, bands and honesty; free
pnpm verify:lifecycle                    # lifecycle cannot be granted; free, rolls back
pnpm verify:entitlements                 # trust surfaces cannot be paywalled; free
pnpm verify:embeddings                   # embedding path priced and metered; free
pnpm verify:outcomes                     # outcome signals arrive and dedup; free
pnpm verify:flags                        # a flag records and never enforces; free
pnpm embeddings --status                  # vector coverage; free
pnpm embeddings --backfill 5000           # COSTS MONEY (~$0.06 for the whole corpus)
pnpm lifecycle --status                  # derived states and content governance; free
pnpm lifecycle --deprecate <slug> --note "..." | --supersede <slug> --by <slug>
pnpm registry --status | --import        # skills.sh reconciliation via its sitemap; free
pnpm verify:builder                      # COSTS MONEY — two model calls
pnpm validate:verify | db:verify-rls
```

**Two commands spend money: `pnpm taxonomy --sample` and `pnpm validate --consistency`.**
Both are opt-in, both are capped, and neither runs as part of any default pass. It calls a model once
per skill. Everything else in the pipeline is rules. Treat it as a sampling tool: label a
small batch, read the labels, fix an ambiguous category description in `vocabulary.ts`, run
again. `MAX_BATCH` in `src/server/taxonomy/classify.ts` is a fuse, not a setting.
