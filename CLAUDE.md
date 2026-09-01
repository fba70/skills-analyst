@AGENTS.md

# Skills Foundry

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

## Where things stand — audited 2026-09-01

Snapshot for picking this up cold. Numbers move; the shape does not. Full requirement-level
audit is **`specs/core/02-requirements-spec.md` §10b** — that table is the source of truth,
this is the summary.

| | |
|---|---|
| Corpus | 16,273 indexed · 15,061 canonical / 1,212 near-duplicate variants · 225 quarantined |
| Sources | 431 synced of 903 enabled, 472 never synced — **ingestion is ~48% done by source** |
| Discovery | 2,023 candidates awaiting a decision, mostly from the skills.sh reconciliation |
| Taxonomy | 4,101 labelled · 1,105 held below the floor · **11,298 canonical skills unlabelled** |
| Derived | 16,542 fingerprints · 16,247 signatures · 1,268 variant links — all keeping pace |
| Archetypes | 12 of 13 function categories at v5 · miner 2.1.0 · public at `/archetypes` |
| Builder | live at `/build` · 3 drafts, 1 published through the whole loop, 5 telemetry signals |
| MCP | live at `/api/mcp` · six tools, token-gated, admin-tunable rate limits |
| Spend, cumulative | ~$12. The `llm_usage` ledger starts at RC.2 and shows $0.05; the rest predates metering. |

**Ingestion runs from a local terminal** (`pnpm pipeline --loop 300`), not from the schedule —
a 6,000-skill repository needs longer than any function ceiling, and locally there is none.
Start it in **your own shell**: a loop started from inside an agent session gets killed with
the session, which cost two runs before anyone noticed.

**The taxonomy is now the dominant gap and it is widening fast.** Fingerprints and signatures
track the corpus; labels do not — **11,298 canonical skills carry no servable category**, up
from 6,364 at the last audit, because sync keeps adding skills while classification costs
money and is deliberately manual. Archetypes read only labelled, above-floor assignments, so
they currently rest on **about a quarter** of the corpus. At ~$0.29 per 100 that is roughly
**$33 to catch up**, and the number grows with every pass.

> **This spend is deliberately deferred until sync finishes.** Do not run
> `pnpm taxonomy --sample` without being asked. Labelling a moving corpus means paying twice.

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

**The ordered plan lives in `specs/core/02-requirements-spec.md` §10**, next to the §10b
status table it is derived from. It is not duplicated here: a roadmap in two places is a
roadmap that disagrees with itself, and the spec is the one people review.

The one-line version, unchanged since the last audit: **ingestion and the taxonomy are the
critical path**, and everything else is what to do while they run.

### Smaller named gaps, from the §10b audit

- **R1.1** — no ClawHub connector; registry reconciliation unbuilt.
- **R2.5** — no community flagging into the quarantine queue.
- **R2.8** — no collision-risk check against existing skills in the same category.
- **R4.2 / R4.3** — no live editor; archetype deviations are not visibly marked.
- **R5.1 / R5.3 / R5.4** — elicitation is a form not a conversation; no gap detection; no
  per-suggestion accept/reject, so no structured feedback events.
- **RC.1** — entitlements are absent rather than enforced-in-the-DAL. Nothing is gated today,
  so the free-tier guarantee holds by construction and none of the mechanism exists.
- **RC.4** — no billing webhooks; there is nothing to sync entitlements from yet.

### Deliberately deferred

- **Embeddings / pgvector** — needed for R5.2 retrieval at scale, R3.5's emerging-category
  clusters and R3.1's low-confidence queue. Not before the corpus settles.
- **R2.10 sandbox / R2.11 eval harness** — Phase 4, and both need infrastructure this
  project does not have yet.
- **Finishing the code-search crawl** — 38 shards saturated and unsplittable on the size
  axis. **The second axis turned out to be registry reconciliation, not a shard key:** four
  sitemap fetches against skills.sh produced 2,323 new repositories, quality-biased, from a
  channel that finishes. The crawl stays parked and is now unlikely to be worth resuming.

### Re-run these as the corpus grows — all free, all incremental

```
pnpm taxonomy --sample 100     # only unlabelled skills; ~$0.29 per 100 — COSTS MONEY
pnpm taxonomy --sweep          # clears held rows nothing can decide; free
pnpm archetypes --mine-all     # free; append-only, lands as v6 with a changelog
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

`MINER_VERSION` is 2.0.0 and the v1 rows are kept — archetypes are append-only, so the
broken generation stays visible as history rather than being quietly overwritten.

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
- **domain** (26) — what field it serves: marketing, devops-infrastructure, legal, …
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
pnpm structures --extract 500        # structural fingerprints — free, no model
pnpm taxonomy --sample 20            # categories — COSTS MONEY, capped at 100/run
pnpm taxonomy --status | --review | --resync
pnpm verify:lists | verify:revocation | verify:export | verify:takedown | verify:publish
pnpm verify:telemetry
pnpm verify:otp | verify:db-retry        # both free, no network, no database
pnpm verify:http-deadline | verify:rate-limit   # free; both reproduce the bug first
pnpm registry --status | --import        # skills.sh reconciliation via its sitemap; free
pnpm verify:builder                      # COSTS MONEY — two model calls
pnpm validate:verify | db:verify-rls
```

**Two commands spend money: `pnpm taxonomy --sample` and `pnpm validate --consistency`.**
Both are opt-in, both are capped, and neither runs as part of any default pass. It calls a model once
per skill. Everything else in the pipeline is rules. Treat it as a sampling tool: label a
small batch, read the labels, fix an ambiguous category description in `vocabulary.ts`, run
again. `MAX_BATCH` in `src/server/taxonomy/classify.ts` is a fuse, not a setting.
