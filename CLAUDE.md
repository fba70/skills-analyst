@AGENTS.md

# Skills Foundry

A platform that ingests agent skills, validates them, mines structural archetypes from the
corpus, and feeds that back into a builder and an assistant. **The loop is the product.**

This file is the operating manual: the rules, the architecture, and the decisions that must not
be undone. It is the only document a fresh clone gets — `specs/` is gitignored.

- **What is left to build** → `specs/debt.md`, the register of outstanding requirements with
  priority. It is the single forward-looking list; do not start a second one.
- **What was built, and the order it was built in** → `specs/plan.md`.
- **Requirement detail** → `specs/core/01`…`07`. Doc 2 is the requirement spec (R1.x–R8.x,
  RC.x), Doc 6 the workbench programme (RW.x / RK.x), Doc 7 the current one (RD.x).
- **The long-form build narrative** through 2026-09-11 — every war story, measurement and bug,
  431 KB of it — is in git: `git show c264384:CLAUDE.md`. It was removed from here because it
  was loaded into every session. The durable half of it is below.

If the code and a spec disagree, that is a bug in one of them — say which.

---

## Hard rules — the agent proposes, Boris decides

Enforced by `.claude/hooks/ask-first.sh` on every Bash call. **A blocked command is not a bug to
route around** — not with another tool, another spelling, a script, or a subagent.

1. **No commits, no pushes.** Report the change set and a suggested message; the user commits.
   Same for anything that writes to GitHub: PRs, releases, settings, history rewrites.
2. **No new tools without explicit authorisation.** No global or project dependency changes, and
   nothing fetched and run from a registry. Restoring the lockfile is fine. Ask first, naming
   the tool, its version and why.
3. **No migrations applied by the agent.** Edit the schema, run `pnpm db:generate`, read the
   SQL, then stop and ask. `drizzle-kit push` is banned repo-wide — it proposes destructive
   phantom drops on partial and expression indexes, and this schema has both. **There is no
   override**: one was built and removed the same afternoon, because an escape hatch lets the
   agent decide when the rule applies, which is the opposite of the point.
4. **No file deletion.** No `rm`, `git rm`, `git clean`, `git reset --hard`, `git restore`,
   `git stash drop`. Temp files and build output included. Name the paths and ask.
5. **No database calls from API routes.** Queries live in `src/server/**` and are called from
   server components and server actions. `src/app/api/**` may not import `@/server/db`,
   `drizzle-orm` or `pg`; only `src/app/api/auth/**` is exempt. Enforced twice —
   `.claude/hooks/no-db-in-api.sh` and `no-restricted-imports` in `eslint.config.mjs`.

Authorisation is per action, not per session: "yes, install X" does not cover Y, and "yes,
commit this" does not cover the next commit.

### Hand-offs are a numbered list at the end, never prose

Every hard rule ends the same way: the agent stops and Boris runs something. So every response
that needs him to act **closes with one block** — the last thing in the message — holding the
commands in the order they must run, one per line, copy-pasteable, one line of reason each.
Migrations, backfills, installs, commits: all of it, in one place.

Not scattered through the explanation. `draft_blocks` was once applied and then its migration
files deleted, because the tidy-up and the apply were two commands in two different paragraphs
and the tidy-up was read as replacing the apply.

---

## Stack

Local development only. No deploy, no CI.

| | |
|---|---|
| Package manager | pnpm (only) |
| Framework | Next.js 16.3.3, App Router, `src/`, Turbopack |
| React | 19.2.8 |
| Styling | Tailwind CSS v4 + shadcn/ui, vendored into `src/components/ui` |
| Theme | tweakcn "Northern Lights", CSS vars in `src/app/globals.css`, next-themes |
| Auth | better-auth **1.7.2, exact pin** — emailOTP, admin, organization, localization, nextCookies |
| DB | Neon Postgres via `pg` over TCP + Drizzle ORM + pgvector 0.8.6 |
| Models | AI Gateway. Every id is a **setting**, never a constant (`src/lib/models.ts`). `LLM_ENABLED` unset means no model is called at all — see below |
| Mail | Nylas. `MAIL_TRANSPORT=console` locally, so a laptop cannot quietly email people |
| Storage | Cloudflare R2, one bucket `skills-foundry` (EU jurisdiction) |

**Pin better-auth exactly.** Core and plugins move in one edit — two copies of
`@better-auth/core` crash at startup. Re-derive its table shapes with `getAuthTables()` from
`better-auth/db` whenever a plugin is added or the version moves; never hand-tune those columns.

## Layout

```
src/
  app/
    page.tsx                     public home
    (auth)/                      sign-in, sign-up
    (public)/                    registry, archetypes, tools, wanted, FAQ, submit — no account
    (protected)/                 dashboard, build, curate, capture, settings, account
                                 — server-guarded: the layout calls requireSession()
    api/auth/[...all]/           Better Auth — the only DB-touching route
    api/skills/[slug]/download/  export (R8.2)         ] route handlers are the documented
    api/mcp/                     the agent surface     ] exception: a wire protocol or a file
    api/interview/[sessionId]/   streamed interview    ] download cannot be a server component
    api/v1/                      public metadata API   ] (renders HTML) or an action (returns
    api/billing/webhook/         entitlement sync      ] a serialisable value)
  components/{ui,layout,auth,registry,builder,archetypes,settings}/
  lib/                           leaf modules: no imports, safe on both sides of the boundary
  server/                        server-only. Nothing here may reach the client.
    auth/ db/ dal/ mail/ ingest/ crawl/ connectors/ validation/ analytics/ taxonomy/
    builder/ interview/ distill/ evals/ skills/ curation/ compliance/ billing/ mcp/
    notifications/ campaigns/ settings/ pipeline/ storage/ http/ llm/
  proxy.ts                       Next 16's renamed middleware. Optimisation only.
migrations/                      generated SQL, committed
scripts/                         the CLIs and every verify:* suite
```

**`src/lib/*` exists because of a recurring build failure**, not by taste: a client component
cannot import a `server-only` module, so any vocabulary both sides need lives in a leaf module
with no imports — `block-types.ts`, `dialects.ts`, `quality.ts`, `capabilities.ts`,
`section-roles.ts`, `models.ts`, `tools.ts`, `licence.ts`, `tokens.ts`, `plans.ts`,
`faq.ts`, `gates.ts`. Sixth time it was needed; it is a convention now rather than a discovery.

---

## Architecture invariants

### Database access
Every query lives in `src/server/**`, called from a server component or a server action. Every
module under `src/server/` starts with `import "server-only"`.

### Auth boundary
`src/server/dal/session.ts` is the boundary. `getSession()` is request-cached;
`requireSession()` redirects. **Every protected page and every server action resolves it for
itself** — `proxy.ts` only checks that a cookie exists, and a POST to a server action reaches
the handler without passing a proxy matcher. A server action *is* a POST endpoint: a page guard
protects the view, not the operation.

Any function taking an explicit `organizationId` stays in a `server-only` module and checks
membership itself. Never `"use server"`.

Sign-in is passwordless — email plus a 6-digit code, same flow for sign-up. Every user gets a
personal organisation on creation and every session starts with it active. **System admin** is
`user.role`, the field Better Auth's admin plugin already checks, not an org role; `ADMIN_EMAILS`
grants it on sign-up and `pnpm admin:grant` is the way back in after a lockout. `/settings` is
admin-only three times over: the sidebar link, the page (`notFound()`), and `requireAdmin()`
inside every action.

### Tenant isolation, two layers
Layer 1 is the DAL. Layer 2 is Postgres: the app connects as **`app_runtime`** (NOSUPERUSER,
**NOBYPASSRLS** — the owner carries BYPASSRLS, so policies written for it would silently do
nothing). `src/server/dal/scope.ts` opens a transaction and issues `SET LOCAL app.org_id`. Use
`withOrgScope` / `withPublicScope`; `withExplicitOrgScope` is for background work with no
session and stays `server-only`.

**Add the policy in the same migration as the table.** RLS defaults to deny, so a new table
without one is invisible to the app rather than merely unprotected. `pnpm db:verify-rls` proves
the three properties end to end and must be run after any schema change that adds an org-scoped
table.

Five tables carry a **split policy** — SELECT open, writes org-scoped — and each is safe
*because of its column list*, which the migration says out loud: `builder_signals` (cross-org
aggregation is the whole point of R6.2, and an org-scoped read would let an archetype learn from
one tenant at a time), `mcp_tokens` (the lookup is how the organisation is discovered),
`org_entitlements`, `mcp_usage`, `outcome_signals`. **Add a column carrying tenant content and
the policy becomes wrong.**

**Append-only ledgers have no DELETE policy**: `llm_usage`, `eval_runs`, `mcp_usage`,
`platform_settings`, `draft_revisions`. An application that can delete its own charges has no
audit trail; a settings row that can be deleted silently restores a default, which is the one
transition an operator would not expect and could not see in the log.

### Migrations — the only way the database changes
```
# 1. edit src/server/db/schema/
pnpm db:generate     # writes migrations/NNNN_name.sql + meta snapshot
# 2. READ the generated SQL before applying it
pnpm db:migrate      # applies on DATABASE_URL_UNPOOLED (direct endpoint)
# 3. commit migrations/ together with the schema change
```

- **Drizzle owns the whole object, RLS included.** A migration file is `drizzle-kit` output and
  nothing else — no hand-written SQL appended. Declare a policy with `pgPolicy(...)` on the
  table and `db:generate` emits it. A hand-appended policy is a second source of truth nothing
  can compare, and it arrives in a later migration than the table, leaving a window where
  `app_runtime` reads zero rows. The one documented exception is `CREATE EXTENSION` for
  `pg_trgm` (0017) and `vector` (0028), which a Drizzle schema cannot express.
- **No `GRANT` is needed and none should be written.** Migration 0002 set default privileges for
  `app_runtime`, so every table a migration creates is already reachable. The explicit grants in
  0018–0020 are redundant belt-and-braces and are not the pattern to copy. Never a live `GRANT`.
- Migrations 0002–0020 keep their hand-written policy blocks — applied history; re-declaring
  them would make drizzle propose creating policies that already exist.
- **Two endpoints, on purpose.** `DATABASE_URL` is Neon's pooled endpoint and is what the app
  uses. `DATABASE_URL_UNPOOLED` is the same database on the direct endpoint, for migrations and
  `CREATE INDEX CONCURRENTLY`, which the pooler cannot run.
- **Migration-before-code is the normal order** and a loud failure is the right way round:
  0029, 0034, 0035, 0043, 0050 and 0054 each turn a green suite red until applied.
- **Dry-run a hand-reviewed migration inside a rolled-back transaction** against the real
  database. That is what caught 0021's `array_agg` over a `text[]` column returning a 2-D array.
- The only scripts allowed to change the database are **data scripts** — backfills through the
  Drizzle query builder, idempotent, so a re-run is a no-op (`scripts/fix-slugs.mts` is the
  model). The single exception is `set-runtime-role-password.ts`, which issues a live
  `ALTER ROLE … PASSWORD` because a password cannot be committed, and builds the statement with
  `format(%I, %L)` since `ALTER ROLE` takes no bind parameters.
- `.claude/hooks/migrations-only.sh` blocks `drizzle-kit push` and hand-typed DDL. Reads are not
  blocked.

### Object storage
One R2 bucket, `skills-foundry` (EU — the S3 endpoint host needs the `.eu` part or you get
`NoSuchBucket`). Prefixes by trust level: `public/`, `quarantine/`, `drafts/`. Keys are
content-addressed — `sha256/<hash>/<file>` — so the key *is* the hash the verdict covers, and
integrity is structural rather than checked.

> **NEVER attach a public custom domain to `skills-foundry`.** R2 grants public access per
> *bucket*, never per prefix. A domain here would expose `quarantine/` — content we assume is
> malicious — and `drafts/`, which is private tenant data. Public content moves to its own
> bucket before any CDN-served public serving exists. This is the one storage rule that cannot
> be worked around later.

Serving bytes is a choice between a proxy route (simple; 4.5 MB cap and egress) and short-TTL
presigned GETs (no egress, but the URL is a bearer token until it expires — public corpus only).

---

## Where things stand

`pnpm db:audit` is the live version of this table. It is free and read-only, and it reports
**subjects covered against subjects to cover** rather than rows at an older version — on an
append-only table the second reports permanent history as permanent unfinished work.

| | |
|---|---|
| Corpus | 49,134 indexed · 47,855 canonical · 1,053 quarantined |
| Sources | 888 synced of 896 — ingestion is done and self-maintaining |
| Taxonomy | 46,489 labelled at vocabulary 1.7.0 · 0.35% held · ~1,300 unlabelled |
| Derived | 50,965 fingerprints (extractor 2.1.0) · 1,620,316 blocks · 47,854 embeddings |
| Archetypes | 13 categories at v9 (`review` v10), miner 3.0.0, block grammar published |
| Schema | 56 migrations, 50+ tables, all applied |
| Verification | 57 `verify:*` suites, plus `pnpm verify:baseline`. Only `verify:builder` always spends; two more spend on `--live` |
| Spend, cumulative | ~$31.80, all metered |

**Doc 2 and Doc 6 are complete** — milestones M1–M6, twenty-three steps. **Doc 7 is in
progress**: P0–P6 built, P7 measured and deliberately unpublished, P8 and P9 not started.
Everything outstanding, with priority, is in **`specs/debt.md`**.

Ingestion, classification and every backfill run **from a local terminal, in your own shell** —
a 6,000-skill repository needs longer than any function ceiling, and a loop started inside an
agent session is killed with the session, which cost two runs before anyone noticed.

---

## Verification house style

Every step ships a `verify:*` script, and the shape is not optional.

- **Reproduce the failure first, then assert the fix.** A fixture that no longer reproduces the
  bug passes for the wrong reason. `verify:http-deadline` starts a server that accepts and never
  answers; `verify:blocks` asserts the guardrail cue genuinely fires before asserting the
  ordered-list rule beats it; `verify:scope` builds the type-confound document and shows the
  naive reading calling it a confident split.
- **A check that cannot observe the failure is not evidence.** "No bare `fetch(` remains in
  `src/server`" was proven with a grep that structurally could not see `aws4fetch`'s
  method-shaped `fetch`. It returned clean and meant nothing, and the next run hung.
- **Execute the query; do not assert that the SQL exists.** Selectors are exported
  (`pendingScopeVersions`, `parameterNameCounts`) so the suite runs them. Four listing queries
  had been returning zero since the day they were written because no suite ever called them.
- **Gate data assertions on there being rows** and print `skip` with the command that fixes it.
  `count(*) where value not in vocabulary` is trivially zero on an empty table; `verify:blocks`
  went green on an empty table twice, and `verify:dedup` stayed green through a total ingestion
  outage by asserting the data was tidy instead of attempting the insert that caused the bug.
- **Assert your own preconditions.** A suite whose subject is the eval gate must fail loudly
  when validation refuses the fixture before that gate is ever consulted.
- **Clean up in a `finally`, and assert the world is as it was found.** `verify:schedule` left
  the live scheduler holding clamp-test values; `verify:models` left the classifier pointed at a
  model ten times the price; two suites left `llm_usage` rows behind, inflating the number the
  next cap decision reads.
- **Free by default.** A budget is arithmetic and a refusal; a test that burns money to check a
  spend cap is self-defeating. The three suites that spend say so and are opt-in.

---

## The subsystems

### Ingestion and provenance

**Four discovery channels**, in descending precision (Doc 4 §4) — the precise ones are cheap and
produce a quality-biased corpus, which is what archetypes should be learned from.

| | | |
|---|---|---|
| 1. Seed allow-list | ✓ `crawl/seeds.ts` | `pnpm seed --repos` |
| 2. Curated-list expansion | ✓ `connectors/awesome-list.ts` | `pnpm seed --lists` |
| 3. GitHub code-search crawl | built; **parked** — 38 shards saturated on the size axis | `pnpm crawl` |
| 4. Registry reconciliation | ✓ skills.sh via its advertised sitemap | `pnpm registry` |

- **Seed entries are verified against the GitHub API before being hardcoded.** That list has
  been wrong: a 404, three entries naming no repository, one list masquerading as a skill repo.
  `SEED_REJECTED` records each with its reason so nobody re-checks them.
- **A list is a discovery source, not a content source.** `awesome_list` sources are read for the
  links inside them and excluded from `pendingSources`, or the sync would ingest the list's own
  README as a skill.
- **Nothing is auto-promoted from a registry.** The upsert refreshes `lastSeenAt` and touches
  neither status nor `skipReason`, so a repository a curator rejected is not resurrected.
  `hitCount` stays 0 — "a list named this" is different evidence from "the crawl saw N markers",
  and `discovered_repos.hit_count` is *not* the marker count.
- **Repository identity folds case** (migration 0021). GitHub resolves `owner/repo`
  case-insensitively and our indexes did not, so 15 repositories existed twice — one fetched
  twice, its skills split, its quota spent twice. Folded **in the index, not in the row**: `name`
  and `url` keep GitHub's casing because that is what attribution should show. `kind` is part of
  the key, because one URL can legitimately be both an `awesome_list` and a content repo.
  `sameRepoUrl` / `sameRepoSegment` at every identity resolution — including
  `compliance/takedown.ts`, where a casing difference meant a block that silently did not enforce.
- **A source is fetched completely or not at all.** A partial enumeration would make R1.5
  tombstone everything it did not reach. So `maxSkills` is checked *before* the fetch begins
  (enumeration is two API calls, already paid for) and an oversized source is **held for review**;
  `syncBudgetMs` is checked *between* sources, capping an overrun at one source rather than the
  queue. Tombstoning reads `seenPaths` from the enumeration, never from what was fetched.
- **Per-item failure isolation is a property of the primitive.** `mapSettled` records per-item
  failures and never rejects. One unreadable bundle once cost an entire 6,864-skill repository,
  and one refused insert nearly discarded 500 computed verdicts.
- **Git symlinks are not documents.** A symlink is a blob whose content is the target path;
  217 of 245 "no frontmatter" quarantines were symlinks. `mode: 120000` is filtered out at
  enumeration — skipped, not resolved, because following relative paths out of a bundle is a
  directory-traversal problem we would be choosing to have.
- **The licence chain has six steps and four run.** Steps 4–5 (ClearlyDefined, ScanCode) are
  measured and declined: 85 of the 92 unresolved repositories have no licence at all. A re-sync
  **refreshes** a licence rather than discarding it — the content-hash dedup used to return
  `unchanged` before any licence write, so a resolver improvement could not reach synced rows.
- **`REDISTRIBUTABLE` has exactly one definition** (`src/lib/licence.ts`). It had six.
  `verify:improve` scans for a seventh. A rule about what may legally be copied must not have
  copies.
- **Revocation (R1.5), three rules:** a failing new version never withdraws a good one (fall back
  to the newest still-indexed); a changed version is `revalidating` where a new one is `pending`;
  deletion is detected only on a complete enumeration.
- **The schedule is data** (`platform_settings`, Settings → Schedule). Vercel Cron fires at a
  fixed expression; the setting is a **minimum interval** the route checks, so it throttles and
  switches off and cannot accelerate. `CRON_SECRET` gates it and **fails closed when unset** —
  the alternative is a deployment quietly unprotected exactly when somebody forgot to configure
  it. Every pass writes a `pipeline.completed` / `pipeline.partial` event tagged with its trigger.
- **Nothing that costs money is scheduled.** Not a "until we get round to it" — a job that spends
  is a job nobody can leave switched on. Archetype refresh also ships OFF: it is free, but it
  republishes the guidance every future draft is scaffolded from.
- **The heartbeat is a progress record, not a completion record.** A pass that hangs writes no
  completion event, so "ingesting a huge repository" and "stalled on a dead socket" produce
  identical evidence from outside. One row updated *during* a stage — stage, sentence,
  done/total, pid — throttled to one write per 15s, and it **never throws**.
- **Every outbound call has a deadline** (`server/http/deadline.ts`, `r2Fetch`). Node's undici
  defaults do not cover a half-open connection: the socket stays ESTABLISHED and the read pends
  for ever. `REQUEST_TIMEOUT_MS` 30s; recursive git-trees get 120s, because a false timeout on an
  enumeration is not a retry, it is a tombstone.
- **Bundle reads are bounded-concurrent at 6** (`lib/concurrency.ts`), because the pool is capped
  at ten and each lane holds a connection. Sequential reads were 42 of every 50-minute pass;
  measured 801 ms → 182 ms per bundle.
- **Run the pipeline, not the stages.** The order is a dependency chain. Running stages
  separately is how fingerprints fell 1,566 behind and dedup signatures 2,240 — neither raises an
  error, they just look like a smaller corpus.

### Validation — the trust boundary

- **Four free deterministic analyzers run by default**: structural-lint, secret-scan,
  injection-scan, capability-surface. That set stays free, because a validate pass you have to
  think about before triggering stops getting triggered. **R2.3 description-consistency is
  opt-in** (`--consistency`): it asks a model whether the documentation honestly describes the
  bundled code, targets only bundles containing code, and returns a pass with no model call when
  there is none.
- **Analyzers are dialect-aware.** `structural-lint` once read `frontmatter.name` for everything
  and quarantined **121 of 121 AGENTS.md files**, a dialect that has no frontmatter by
  specification. The rule to apply is *does this skill have a name*, not *does this YAML key
  exist* — those are the same question for exactly one dialect.
- **Identity blocks; convention warns.** Nothing anywhere identifying or describing a skill is
  `high` and quarantines. A missing YAML block where the name is derivable is `medium` and
  indexes — hiding 257 real skills over a convention was a quality decision wearing a trust
  decision's clothes. Absent frontmatter and *malformed* frontmatter are different faults with
  different messages: a colon in an unquoted description makes YAML read a nested mapping.
- **R2.3's thresholds are deliberately timid** (fail below 35, warn below 70). The hard blocks
  stay with the analyzers that have no opinions.
- `ANALYZER_VERSIONS` is derived from the analyzer objects so it cannot drift. `pnpm rescan`
  re-judges every version whose newest verdict predates the current version — not "skills that
  look affected", which is how 4,179 passing skills were left behind by three throwaway scripts.
- **Quality score is bounded at 100 and thousands tie there.** It is a display, never a
  discriminator: never band on it, never rank a library on it. See the archetype note below.
- **Takedowns (R7.5): a persistent record consulted before fetching.** Reusing the tombstone path
  would have looked finished and been wrong — a tombstone is designed to reverse itself, so a
  takedown would be undone within 24 hours on a schedule. Keyed on **`(source_url, skill_path)`**,
  duplicated out of the join columns so the block works when those rows are gone, and **not** on
  the content hash, which an author defeats by editing the file. Only `upheld` enforces:
  enforcing on arrival lets anybody who can send an email un-list a competitor. `withdrawn` is a
  separate status from `tombstoned` — same end state, different re-ingestion rule and a different
  sentence to a reader. Download returns **451**, not 409. Reinstating lifts the block and rests
  versions at `tombstoned`; it does **not** restore content, because the bytes were deleted.
- **Quarantine precision is measured, and the measurement has a denominator.** Doc 3 gates the
  public rollout on ≥90% upheld on spot-check, and for a long time three files said so while
  nothing computed it — because the schema recorded only the *disagreements*. Releasing wrote a
  `curator-override` verdict; agreeing with the analyzer wrote nothing, so *reviewed and correct*
  and *nobody has opened it* were one silence and the only expressible figure was
  `1 − released ÷ ever-quarantined` — **a lower bound that reads highest when nobody is
  checking**. `confirmQuarantine` is the other row (a `curator-review` verdict, no migration, and
  the status deliberately unchanged), so precision is now measured over what was **reviewed**,
  never over the queue — a gate denominated in a thousand versions nobody can read by hand could
  never be cleared by any amount of work. Coverage travels with the number, the figure is
  withheld below `MIN_REVIEWED_FOR_PRECISION` rather than shown greyed out, and the targets live
  in `src/lib/gates.ts` so the sentence and the comparison beside it cannot drift.
  `verify:precision` computes the naive form on the same data and requires it to be confidently
  wrong first.
- **Reader flags are recorded and enforce nothing** (B2). Upholding queues re-validation rather
  than quarantining, so the analyzers still write the verdict that explains the outcome, and only
  an **upheld** flag records the adverse outcome signal. A rejected flag is kept: a refused claim
  is still a claim that was made. The `publicWrite` limiter **fails closed**, inverting the read
  scopes — nobody legitimately files twenty reports a minute.

### Corpus analytics

**Taxonomy — two axes** (`taxonomy/vocabulary.ts`): **function** (13) is what the skill does and
is the only axis archetypes are mined on; **domain** (29) is what field it serves and drives
browse. Structure follows function — a contract review and a pull-request review share a shape;
mining per domain would average a rubric with a template and fit neither.

- Nothing in the corpus declares a category, so the taxonomy is derived and closed.
- **The confidence floor applies everywhere, including the miner.** It was applied in the
  registry and missing from archetype mining, so a fifth of one category's evidence was labels
  the classifier itself had flagged as unreliable. A curator-reviewed row counts whatever its
  score.
- **The no-classify rule is structural, not a length threshold.** Measured: "shorter than 40
  chars" would have dropped 93 confidently-classified skills to clear 137; "empty or a single
  bare token" clears 12 and drops 2. A threshold tuned to clear the queue buys queue depth with
  correctness. It is a **selector, not a state**, so a skill whose description improves upstream
  becomes eligible again.
- **The table keeps no history** — `classifier_version` is a column, not part of the unique key,
  so re-classifying overwrites. `--compare` therefore has an integrity check and **exits non-zero
  rather than printing a confident wrong answer**: the surviving old rows are exactly the labels
  the new vocabulary stopped assigning, which flatters the new vocabulary by construction.
- **Report rates per skill, never as a share of labels.** When labels-per-skill falls, a category
  can shrink in absolute terms while its share holds steady. That mistake once inverted a
  conclusion.
- **An instruction beats a definition.** Narrowing a category's description made it *more* used,
  because the prompt named it as the fallback two rules later. The function axis held at 2.7% and
  the domain axis at 9.8% on the same call — one was asked to be decisive and was.
- **A vocabulary bump must not look like data loss.** Scoped counts read empty at the moment of a
  bump; the panel falls back to the newest superseded version and says so.

**Structural fingerprints** (`skill_structures`) store heading tree with normalised **section
roles**, body metrics, resource layout, frontmatter conventions, tool references, version pins
and `allowed-tools`. Pure rules, no model — so re-extraction is free and `EXTRACTOR_VERSION` is
the re-scan selector, exactly like `verdicts.analyzer_version`. Roles rather than raw heading
strings, because three spellings of one idea would report three sections at 33%.

**Blocks** (`skill_blocks`, migration 0024) are the grain below the heading: eleven types,
rules-only detector, one row per typed span.

- **A row is a coordinate, never content.** `[startChar, endChar)` into the marker body and no
  text, so a fragment resolves live under the licence gate, a withdrawn skill stops being
  quotable immediately, and an edited skill cannot be misquoted — the offsets belong to one
  `content_hash`. **This table may never grow a column holding body text**; asserted against
  `information_schema`, not against today's data.
- **Structure beats lexicon, and the order of the rule tiers is load-bearing**: the passage's own
  syntax, then the section the author declared, then structure inside the passage, then wording.
  Procedures are written in modal verbs, so a lexical guardrail rule above the ordered-list rule
  turns every numbered procedure in the corpus into a prohibition.
- **`type` is nullable and the unclassified share is reported.** Doc 6 §7 names over-structuring
  as this programme's risk; a taxonomy that types every passage is guessing. `verify:blocks`
  fails if the unclassified share ever reaches zero. A bare code fence stays unclassified
  deliberately — "we found 204 examples" is a claim RW.6 can stand on, "700" is not.
- Blocks are **replaced, not upserted**: the row count changes when the rules change, so there is
  no key an upsert could target.

**Archetypes band on source trust, never on the quality score.** Banding on quality quartiles
produced a confident, wrong archetype — *good review skills are single-file with no code
examples* — because the score is bounded at 100, every multi-file bundle collects an `info`
finding, and so no multi-file skill can reach 100. Every sign flipped when the bands became the
curated seed list against everything else. Curated skills average 95 on our own metric against 97
for the rest, which is the clearest statement that the metric was measuring the wrong thing.

- **Evidence is counted in distinct structures and distinct sources, never skills.** One
  generator's 800 clones are one data point. The same argument recurs at fragment scale (one
  fragment per source), at token scale (tools ranked by distinct repositories) and in
  `MIN_GUARDRAIL_SOURCES`.
- **`CURATED_SOURCES` is a proxy and must be maintained**, which makes *not* editing it a
  decision. It silently went stale once: 18 repos supplying 1.8% of the corpus, with 27
  first-party vendor repos holding 2.3× that banded as untrusted, and one organisation on both
  sides of the contrast. The written rule is now *first-party — the GitHub organisation owns the
  product the skills document*, checkable rather than a taste judgement. Stars get no vote.
- **`MIN_LIFT` scales with the evidence**: three standard errors plus an 8-point floor. A flat 12
  was set when a band held ~90 representatives and had silently become a 4-sigma test at ~300.
- **A miner bump must beat the skip.** `mineAndStore` skips on an unchanged skeleton *and* a
  matching miner version, so new evidence reaches exactly zero archetypes unless the version
  moves. That trap caught 2.1.0's attribution and 3.0.0's blocks; `verify:decision-surface`
  asserts the relationship so it cannot catch a third.
- **Archetypes are append-only.** Earlier rows stay as history for R7.2 reproducibility and R3.5
  drift-diffing.
- **Negative lift is never published as guidance.** `stance` (−6) and `anti-example` (−5) earn
  nothing in any category; the second contradicts Doc 6 §2 head-on and the detector is a live
  suspect, because it fires on punctuation markers that long-tail skills reach for and vendors do
  not. A negative claim invites an author to *delete* knowledge, so it deserves a higher bar.
  `verify:archetypes` refuses any published block with non-positive lift.
- **The finding that shaped the programme:** section presence stopped discriminating at full
  coverage (best section lift +10) and blocks discriminate about twice as well —
  `reference-pointer` 11 of 13 categories at median +19, `decision-rule` 10 of 13 at +22.
  Density adds a dimension presence cannot reach.
- **Measure structural diversity, not source concentration.** A share cap penalises a large
  varied repository and ignores a tiny monoculture. `templateClusters()` groups by structural
  signature. Volume is an asset and noise is acceptable input; monoculture is acted on in
  archetype *weighting*, never by rejecting content.

**The block library** (`analytics/block-library.ts`) answers *what does a good one look like*.
Ranked quotable-first, then curated, then **distance from the median length of that type in that
band** — the first ranking sorted on `quality_score` (degenerate) and therefore on
`word_count desc`, reliably returning the biggest passage that fit. **No copy button, and
fragments never reach a generation prompt**: most of this corpus is `attribution_required`, and a
model handed attributed prose reproduces it into a document carrying none. What travels instead
is our own vocabulary about the corpus — a type's label, blurb and two prevalence numbers.

**Embeddings** (A6, migration 0028) embed **the claim** — name, summary, category labels — not
the body, because every consumer compares what a skill says it does. Body-level similarity, if
ever needed, is a **second embedder over blocks** with its own composition, not a wider window on
this one. `EMBEDDER_VERSION` carries model, width *and* the field list, because only a composition
change can produce vectors that sit beside older ones, look current, and cannot be compared.
HNSW, not IVFFlat (no training pass to forget). Canonical skills only. Batches run sequentially,
against the six-wide bundle reads, because parallel batches all pass the budget check before any
cost is recorded.

**The scope analyser** (`skill_scope`) asks *is this one skill or three*. Cluster any document's
blocks and you get two clusters — frequently of *block type* rather than subject — so
`typeAlignment` refuses a split whose seam is the types, and returns null when either half is
mostly untyped (59% of corpus blocks are). Seeds are the two most dissimilar blocks, so the
verdict is reproducible. `MIN_SPLIT_SEPARATION` is **0.474, the median of a synthetic control**
(two unrelated skills glued together), up from a guessed 0.22 that called 51% of the corpus a
split candidate; the re-run landed at 3%, as predicted. The threshold is set to **miss rather
than accuse**, and the surface says so. There is no builder panel yet, deliberately.

**The decision surface (RD.5) is measured and unpublished.** `DECISION_PARAMETERS` ships
**empty**, `vocabularyReady()` is false, and every reader prints *not measured yet* rather than
*no parameters found*. A model reading 23,476 documents returns `env`, `environment`, `target
environment` and `ENV` for one idea; a **curated label** is what may reach a page, and writing a
plausible list from memory is the failure `seeds.ts` was burned by. The clusterer embeds the name
alone — adding observed values made a singular and its plural sit at 0.531 and nothing merged.

**Tools are a third taxonomy** (`src/lib/tools.ts`, 103 entries), seeded from a measured
distribution — the head of 9,442 candidate tokens by **distinct repositories**, read and curated.
Coreutils are in: a "does knowing about it change a decision" line excludes `cat` at 191
repositories while keeping `qpdf` at 19, which is not a defensible reading of the table it was
written from. `skill_structures.tool_refs` keeps every candidate token, so widening the list is
`--resolve-tools` and a minute rather than a 2.5-hour re-extract. `resolveTool(token, evidence)`
takes the evidence, because `read`/`grep`/`bash` are Claude Code tools *and* shell words.
`destructive` is 24 of 103 and stays narrow — installing a package is not destructive, deleting a
cluster is; a flag true of everything is an alarm nobody can silence. **The unrecognised share is
printed every time and must never reach zero**, and the *reference* share leads (52.3%) because
the distinct-token share (1.3%) answers a different question.

**The tool axis does not discriminate** — 0 of 103 tools clear the archetype threshold in 13 of
13 categories, because tool choice is a stack decision, not a craft convention. So no tool
dimension is published and **the generation prompt must never learn which tools a category
reaches for**: a model told good review skills use `gh` writes `gh` into a skill for a team on
GitLab. What the corpus did support is a conditional share within one band — *83% of curated
skills that name `git` carry a guardrail, over 240 skills from 40 repositories*.

### The builder and the workbench

**A draft is typed blocks and the body is a render.** `draft_blocks` holds type, order and the
author's text; `null` type stays valid content. **`skill_drafts.body` has exactly one writer**,
asserted by a tree scan that also asserts the whitelist matched something. Publish-back (R6.1)
and export (R4.4) take a body and **must not learn about blocks** — a block-aware export would be
a second definition of "servable", on the axis where drift is a legal problem rather than a bug.

- **The extractor's spans do not cover the document.** It treats a heading as a boundary, not a
  block, so concatenating its spans loses every heading. `tileDraftBody` merges typed spans with
  `headingSpans` collected by the same segmenter and reads the gaps from the body. One segmenter,
  or fence handling has two implementations.
- **Ids survive a replace**, which is what makes R4.7 possible: a revision diff matches on id, so
  a block that only moved is recognisably the same block. Over a body string `moved` shows up as
  a deletion and an unrelated insertion far away.
- **Restoring a revision appends**, never truncates. A history that deletes itself when used is
  one nobody dares click.
- **`ready` is set on content**, not on a non-empty body: an empty scaffold renders to a list of
  headings, which *is* a body.
- **Nothing is pre-filled from anybody's prose.** "Add one here" inserts an empty typed block.
- **Deviation marks re-measure the draft with `extractStructure` itself** — the instrument that
  produced all 1.6M corpus blocks. A second, lighter detector would drift, and every drift
  surfaces as a deviation the author cannot act on. **Nothing is blocked**: a missing block states
  the evidence and stops, an extra type carries no judgement, and density is reported and never
  scored.

**Interview mode** scripts five techniques, each with its own prompt naming its own failure mode
— walkthrough drifts into summary, contrastive probing into flattery, exception mining into
hypotheticals. **Every turn emits candidate blocks already typed**, and accept/reject is R5.1 and
R5.4 in one motion: there is no thumbs-up control, because the feedback *is* the action the
author already wanted to take. Targets bias, they do not restrict. A rejected candidate is kept
(a technique whose candidates are always rejected is only prunable if the rejections exist), and
`accepted` and `edited` stay apart. Candidates are **appended, never placed** — the archetype's
typical position is a median over a corpus, not a statement about this document.

**Distill mode** reads Claude Code transcripts. **645 of 685 `user` rows carry a `tool_result`**
and 40 carry human speech — the naive parser would attribute the contents of every file read to
the author and send it to a model. Verified rather than assumed: a `user` row's content is a
string or a list of tool results, never mixed, in 685 of 685. Only a **correction** is worth a
call, matched on whole words on human turns only. The **transcript is never stored**: provenance
is a turn uuid, a coordinate into a document the platform has never seen. Redaction is a second
line, tuned asymmetrically — over-redaction costs a candidate block, under-redaction sends a
credential to a third party. One candidate table, not two, or the second accept path forgets the
revision note, the eval case or the feedback event.

**Improve an existing skill** decides its source from the data, never from a parameter that could
declare away the licence gate. A fork is the library's refusal at whole-document scale: only a
redistributable posture may be forked, the obligation is **frozen onto the draft** (a licence that
vanishes because an upstream row was deleted is the failure with legal consequences) while the
upstream's *display* resolves live, and publishing a fork **inherits the upstream posture,
licence and licence source** rather than claiming `authored`. `draft_resources` gives a draft
files — text in a column, not bytes in a bucket, since a draft is mutable, private and deleted
with its author; paths are refused if they climb out of the bundle.

**Parameters and structured rules** (P4) keep the document as the artefact: no new frontmatter
key, structure → prose is a deterministic render, prose → structure is a model *candidate* the
author confirms, and an author who edits a rendered table detaches it. Confirming a rule writes
`rule` and never `text`, so the body's single writer holds and a revision with an empty diff is
never created. **Coverage says which zero it is** — an enum with no declared values is *not
measurable*, and an explicit *otherwise* row counts as covered. Nothing here gates publishing,
and the suite scans `publish.ts` to prove it.

**Tool alignment** (P2) compares three places a skill says what it runs: the steps, `allowed-tools`
and the bundled code. **Absent and empty `allowed-tools` are opposite facts** — no list means
nothing to disagree with; an empty list means every step is refused. A blanket `Bash` grant
answers for every CLI, and one finding covers the whole draft rather than six identical rows.
It is **not a gate**, and the generated grant leaves only through Claude Code's export file —
never at publish, because a published skill's bytes are what a verdict covers.

**Shared blocks are synced, never substituted** (RK.4). This is the one pointer in the codebase
that does not resolve live, and the exception is the design: live substitution would rewrite forty
authors' documents mid-sentence with nothing in any revision history saying so. A transclusion
carries its own copy and the version it came from; when the convention moves, dependents go
*behind* and the author takes the update. Published skills are never touched.

**Scaffolding**: the sections step is the mined archetype, prevalence in both bands carried into
the UI *and* the prompt (R5.2). **Domain affects content, not structure** — it reaches the prompt
inside a `<domain>` tag that says so. Sonnet, not the small model, because the output *is* the
product; temperature 0.4, because at zero "write it again" hands back the same document.
**R5.5's refusal is a field in the structured output**, not a filter around it.

### The Eval Lab

**One probe model.** `skill_evals` holds should-trigger probes, should-not-trigger probes and
golden tasks; D2's trigger lab reads these rows rather than a parallel set that could disagree.

- **A regression blocks a publish; any failure does not.** An aspirational case has never passed
  and failing is its correct state; the naive rule teaches authors that writing cases costs them
  the ability to ship. The gate is *this passed against an earlier document and fails against
  this one*.
- **`error` is not `fail`** — a refused call is a fact about us, and counted as a failure it lets
  our downtime block a customer's publish. **Stale is not failing**: a verdict about an older
  document is not a weak claim about this one, it is not a claim about this one at all. Runs are
  stamped with the document's `content_hash`, which is why nothing re-runs automatically.
- **A trigger probe sees the name and description only.** That is what a consuming agent matches
  on; a probe with the body would pass for skills whose description never fires.
- **A golden task is two calls** — one does the task, one judges it. One call that produced and
  graded its own answer is a model asked whether it did well, and it says yes.
- **`eval_runs.with_skill` is nullable and NULL means a Skill CI run**, so D3's deliberately
  failing without-arm cannot read as a fresh regression.
- **A delta is computed only where all four cells decided.** The naive subtraction reads `1 − 0`
  as a flawless +100 when the budget refused halfway — a number wrong in the flattering
  direction is the one nobody questions.
- **The optimiser never offers an unverified cut.** Nothing regressed, something was actually
  compared, and the saving is over 10%; the saving-only rule is a document shredder. An offer
  stores `source_hash` and stops being current the moment the original is edited.
- **A rule case is a render, not a stored proposal.** The key is the claim — conditions sorted,
  action folded, the block deliberately left out so "make this a table" cannot break every link.
  Three row shapes propose nothing and each says why: an empty action, an *otherwise* row, a row
  naming no parameter.

### Knowledge management

- **The lifecycle is mostly derived, so nobody can grant it.** Only `deprecated` and `superseded`
  are storable — Postgres rejects the rest — and `battle-tested` is earned from outcome evidence
  with every threshold read from `BATTLE_TESTED` rather than written into the SQL.
  `lifecycleExpression()` is the single derivation and `verify:lifecycle` **compiles** it rather
  than holding a copy. Precedence: not indexed → none at all → superseded → deprecated → stale →
  validated. Deprecation does not block a download: it is advice, not a prohibition.
- **Outcome telemetry** dedups with a **daily-rotating HMAC with the day inside the key**, so
  digests are unlinkable across days by construction. Only a *successful* export counts and only
  a *re*-validation counts. The recorder swallows its own failures, so the suite writes **through
  it** and reads the row back — a hand-written insert would prove the table works and nothing
  about the function meant to fill it.
- **Freshness.** Undated is not neglected: a review date is a decision somebody made, and the
  queue selects only dated skills. Link rot is the only freshness signal nobody has to declare,
  and most non-200s are not rot — `broken` (404/410) is the only confident status, beside
  `blocked` and `unreachable`, and `ROT_THRESHOLD` is two consecutive failures reset by one
  success. `HEAD` then a ranged `GET`, because many servers answer 405 to `HEAD` and reading that
  as a dead page would be the largest source of false rot. A **state table, not a log**, keyed on
  the version. Coverage travels with the count.
- **Version drift is a fact, never a demotion.** A skill teaching Next 15 idioms is exactly right
  for a codebase on Next 15. `stale` stays the only freshness signal that moves a state.
  Nineteen projects, and **every feed was fetched before it was written down** — four of the first
  twenty 404'd because they tag rather than release, and tags are not a substitute (release
  candidates, weekly tags from 2012, branch pointers). Standards and model ids are deliberately
  untracked. Precision is per project; nothing surfaces below two releases behind.
- **Demand signals**: a search that returns nothing is logged, and a query enough **distinct
  people** asked becomes a public board. The floor is the whole safety property — five distinct
  searchers, in the query *and* re-applied on the way out — and **no identity is stored**, so
  "what did this customer search for" is a question the schema cannot answer. Median, not mean.
  A query the corpus answers leaves the board however many asked.
- **The knowledge graph stores only what has nowhere else to live** — mined conflicts and
  author-declared edges. `similar-to` is a `<=>` against an index that exists and `supersedes` is
  a column; storing them would be three second sources of truth. Declaring a derived kind is
  refused with a message naming where the answer lives. Conflicts are written as a **symmetric
  pair in one statement**, and they warn rather than refuse: a caller may have good reason to
  install both. The prompt's single test is *is there any one course of action that satisfies
  both rules* — the first version called "at least one reviewer" and "at least two" a conflict.
- **Maintainers and endorsement**: standing is resolved **live** by an inner join, so revoking a
  maintainer un-counts their endorsements on the next query. Nobody endorses a skill from their
  own workspace, the endorsed *version* is pinned, and an empty `scope` returns nothing rather
  than everything — the natural `if (!scope.length) skipTheFilter` reading turns a new appointee
  into a second admin. It is **never a score**: no badge, no column, no sort.
- **Notifications are derived on read.** A watch stores what you follow and when you last looked;
  the feed is a query over `events` since that timestamp. There is no notifications table and the
  suite asserts there is not. The events name a **version** and the watcher names a **skill**, and
  one kind spells its subject type differently — matching one spelling silently drops it. Two
  query shapes, because a skill watch drives from the subject index and a category watch from the
  time index (63 ms and 1.67 s, against twenty minutes for the `or` join). Ten kinds are
  notifiable; the three loudest are not.
- **Campaign progress is derived from the drafts**, never stored. The suite publishes a draft
  *without telling the campaign* and requires it to report 50%. An empty campaign reports **no
  share, not 0%**.
- **Impact analytics carry the collection window with the number**, because most of the corpus
  predates the recorder and "0 downloads" means *nobody was counting*. The impact card renders no
  battle-tested badge: the SQL derivation already computes one, with precedence, and two badges
  from two computations eventually contradict each other on one page.

### Distribution and the agent surface

- **`(public)` vs `(protected)` is the whole boundary** — one layout calls `getSession()`, the
  other `requireSession()`. `/skills` is deliberately absent from the `proxy.ts` matcher. Nothing
  extra was needed in the DAL: an anonymous request resolves no org and lands on `org_id IS NULL`
  with RLS enforcing it rather than a `where` clause somebody can forget.
- **Export is byte-identical across two downloads.** That cost a design change: the receipt
  originally embedded `exportedAt`, which destroyed the one property a consumer can check. ZIP
  mtimes are pinned to 1980-01-01. The licence gate runs **before any object is read**, and the
  receipt carries the content hash, the validation-report hash and the verdicts it covers, both
  recomputable from the archive alone.
- **MCP tools are thin wrappers over the same `src/server/**` function the web pages call.** That
  is RM.2, not laziness: reimplementing a lighter read means two definitions of "servable", and
  the second drifts on licence gating and takedowns. `download_skill` calls `exportSkill` and
  discards the bytes, inheriting all three refusals for free.
- **The untrusted-content fence** wraps corpus text leaving over MCP, carrying slug, source,
  status and quality **and a random 96-bit nonce on the close tag** — the marker is public, and a
  skill that writes our closing tag into its own description would otherwise break out. It does
  not make the text safe; it makes it labelled.
- **Structured input, because the caller is a machine.** Every enum is the real vocabulary, so an
  agent guessing gets a schema error naming the valid options rather than zero results it would
  read as "the corpus has none".
- **A token, not a session.** `mcp_tokens` is ours because better-auth 1.7.2 ships no api-key
  plugin — and it is the better answer: a leaked session is an account, a leaked token reads the
  public corpus through a rate-limited endpoint. Only `sha256(token)` and an 8-char prefix are
  stored. Read limits **fail open** (a rate limiter that fails closed takes the public registry
  dark because a counter table blinked); write limits fail closed.
- **`create_skill` returns a draft and never publishes.** Publishing runs the validators, writes
  corpus rows and makes bytes downloadable; an agent doing that unattended is one prompt away
  from putting a stranger's document into a workspace's registry. The validator runs on arrival
  and its findings go back **in the tool result**, where the agent can still act on them. An
  unentitled caller gets a sentence, not a JSON-RPC failure, and the tool stays listed for
  everyone.
- **The public API serves metadata and never bodies**, which is what makes bulk access lawful:
  96% of this corpus is `attribution_required` and some is `metadata_only` — exactly the posture
  meaning *we may describe it and may not hand it over*. Verdicts come back as **counts, not
  findings**: a bulk-readable index of where the secrets are is worse than the score it produced.
  Two licences are stamped on every envelope, because the skills are their authors' and the
  derived analysis is ours. Cursor-paged on the slug, because an offset silently skips rows when
  the corpus grows under a long export. A withdrawn skill is **410, not 404**.
- **The FAQ is generated from the code, not written beside it.** Categories, capabilities,
  licence postures, section roles, severity weights, the analyzer list *and versions*, the
  evidence gate and the confidence floor are all **imported**. Documentation that restates
  constants is wrong within a month, and a reader who checks one number and finds it stale has
  lost more than the page ever gave them. Badges link into it through a typed `FaqAnchor`, so
  renaming a heading breaks the build rather than silently scrolling nowhere. A badge may not be
  wrapped inside the registry list's card-level `<Link>` — an anchor inside an anchor is invalid
  HTML — so the list gets one plain link near its filters and only detail pages wrap badges.
- **Every facet count is a `GROUP BY` or a `count(*) filter`, resolved where scope is resolved.**
  `getFilterOptions` once selected every indexed skill and tallied it in node, then asked for
  capability surfaces with a 6,100-element `IN (...)` — 2.3 s, growing with the corpus rather
  than the page. **A facet's count and its filter must use the same expression on both sides**,
  and the count must run inside the same `withOrgScope` the rest of the page does: the tool facet
  nearly shipped unscoped, which would have put a signed-in visitor's own skills in the filtered
  list and left them out of the number beside it. `loading.tsx` + `PageSkeleton` is a fix for the
  *perception* only; fix the query first.
- **Mail goes through Nylas, which sends from a mailbox rather than a domain**, so nothing needs
  a verified sending domain. `MAIL_FROM` is an **override**, not the sender, and must be a
  configured send-as alias. Three findings from the first real send, each from a 4xx: omit
  `tracking_options` entirely (a trial account rejects the *field*, whatever the values, and we
  do not want a tracking pixel on a passcode); send **no** `Idempotency-Key` (Nylas remembers it,
  so two identical 6-digit codes to one address collide and it delivers **nothing, silently** —
  and Better Auth does not retry anyway); and v3 takes one body, HTML *or* text, so **the code
  must stay real text in the markup**, never an image or a CSS background.
- **Search is a `tsvector` + GIN index, `pg_trgm` for typos, and ranking as a function** —
  `ts_rank_cd` normalised, `greatest`-ed with trigram similarity, plus quality at a quarter
  weight. **Popularity has no vote at all**, which is the simplest way to guarantee R2.9's rule.
  The generated column passes `'english'::regconfig` explicitly and must keep doing so: the
  one-argument form reads a GUC and is only STABLE.

### Commercial

- **The free-tier guarantee is a refusal, not a flag.** `hasEntitlement(org, "verdicts")` raises
  `UngateableError` rather than returning true. A gate that always passes still *exists*: the
  call site reads as a paywall, and the day somebody tidies the special case away it switches on.
  Ten `FREE_FOREVER` keys — verdicts, provenance, quarantine status, capability surface, quality
  score, licence posture, registry reads, permitted downloads, endorsements, tool surface. Two
  error types, so "should upgrade" and "we were about to break a standing commitment" are not
  caught by the same `catch`. **The absence is the half that matters** on most of them: a
  registry that gives away its good news and charges for the warning is worse than one with no
  endorsements at all.
- **Entitlements live in their own table**, not on Better Auth's `organization` — those shapes are
  re-derived from the library and a hand-added column is exactly what that would not know about.
  An absent row means `free`. **Expiry is read at the gate, never swept by a job**, whose failure
  mode would be a customer keeping what they stopped paying for.
- **`LLM_ENABLED` is a deployment-wide kill switch, and unset means off.** `assertLlmEnabled()`
  runs at the top of `assertWithinBudget` and `assertConversationBudget` — the two gates every
  model call in this codebase already passes — so a new call site inherits it and one that
  forgets the gate is the missing line that already fails review. It is checked **before** the
  ledger read, so a refusal does not depend on the database. Not a cap of zero (that reports a
  workspace out of money and a reset that changes nothing), not an entitlement (those are per
  customer, stored, and reachable by anything that reaches the database), and it exempts no
  purpose — the platform ones included, because "nothing that costs money is scheduled" is a
  convention and this is meant to be the mechanism. Default-off for `CRON_SECRET`'s reason: the
  deployment worth protecting is the one somebody forgot to configure. The builder pages read
  `llmEnabled()` and **hide** the model-backed surfaces rather than disabling them; what is left
  — manual authoring, validation, revisions, publish, export, registry search — is the whole
  product minus generation. `llmEnabled()` is a **function, not a module constant**: a constant
  is captured at import and ESM hoists imports, so a suite could not observe the switch at all.
- **Two budgets, because they protect different things.** A per-org monthly cap stops one customer
  running up a bill; a separate platform budget stops our own batch work doing the same. Mixing
  them lets either failure cause the other. Fail-closed means **refusing, not degrading**: no
  cheaper-model fallback, no soft warning that still spends. The check is before and the ledger
  after, because cost is only knowable once tokens are counted — so one call can carry the total
  slightly past the cap and the next is refused. **Integer micro-dollars.** Cache reads are 0.1×
  and writes 1.25×, and `usage.inputTokens` is the *total*, so billing it alongside the cache
  detail double-counts. An unknown model is charged the most expensive rate known.
- **A conversation gets its own cap, checked per turn, with the remaining budget on screen from
  turn one.** Reservation loses (an abandoned tab holds budget until a sweep that can fail); a
  turn cap alone loses harder (turns are not money, and a transcript that grows every turn makes
  the tenth call several times the first). The cap is the lesser of its own ceiling and what the
  org has left, so it can never advertise 50¢ to a workspace with 20¢. Three refusal reasons, not
  a boolean.
- **A model id is a setting, resolved once per invocation** and used by the call, the budget check
  and the ledger alike — reading it three times lets a save land between two and bill a call at a
  rate the budget never checked. **An unpriced id is refused rather than stored.** Embeddings are
  deliberately not a task: the width is fixed in the column type, so changing that model is a
  migration and a full re-embed, and a control that cannot take effect is worse than none.
- **MCP accounting is a rollup**, `(token, day, tool)`, and the schema choice does not turn on
  storage: a per-request log keyed by token would let us reconstruct what a customer searched for,
  which is the exact question `search_queries` was built to be unable to answer. Refusals are an
  `events` row, not a counter — the limiter runs before a tool is chosen, so there is nothing to
  count them against. Successes are countable; failures are investigable.
- **A late webhook delivery cannot downgrade a customer.** An upsert is idempotent for a
  *duplicate* and blind to a *late* one: a `deleted` delayed ninety seconds lands after the
  `updated` that upgraded somebody. Every delivery carries the provider's timestamp and an older
  one is recorded and refused. An unknown plan **under-acts** (`ignored`, never `free`) — the
  mirror of an unknown model over-charging. A refusal is still a **200**: the status code is for
  the retry policy, and 4xx on a delivery correctly doing nothing is an infinite retry loop.
  Signature verification is twenty lines of `node:crypto`, deliberately not an SDK.

---

## Standing invariants a change is most likely to break

Each is asserted by a suite, and each is here because a reasonable change would undo it with
nothing erroring.

- **`skill_drafts.body` has exactly one writer** (`verify:draft-blocks` scans the tree).
- **`skill_blocks`, `skill_scope` and `distill_runs` hold no body text** — asserted against
  `information_schema`, not against today's data.
- **`REDISTRIBUTABLE` has one definition**; `verify:improve` scans for a second.
- **A published fork inherits its upstream licence** rather than claiming `authored`.
- **The trust surfaces cannot be paywalled** — the gate *throws*.
- **The generation prompt never receives corpus prose, and never receives a category's tools.**
- **No published archetype element carries non-positive lift.**
- **The unclassified block share never reaches zero**, and the unrecognised tool share never does.
- **`evalStates` filters `with_skill is null`**, or a successful matrix reads as a regression.
- **`streamText` is called in exactly one place**, or a call exists with no budget gate.
- **Every file that calls the model SDK calls a gate first** (`verify:llm-off` scans for a
  *call*, not a mention — matching the bare name went green with the gate deleted, because the
  destructured import satisfies it). And the registry read path, the session boundary, sign-up
  and export reach no model SDK at all, asserted by import reachability with a positive control.
- **Nothing from Interview, Distill or outcome telemetry feeds `mineArchetype`.** Creation
  telemetry earned that right by surviving R6.5's trimming; these have not, and wiring a
  near-empty input into the thing that scaffolds every future draft is how a loop poisons itself.
- **R6.5 is four defences, not a flag** — dedup per identity, a rate limit applied *in SQL before
  counting*, outlier trimming **per organisation** (the unit of manipulation is an account), and a
  bounded ±5-point delta per mine. `MIN_DISTINCT_ORGS` sits under all four and serves privacy too.
- **Creation telemetry is structure only** — booleans and values from closed vocabularies we
  defined. That is what makes R6.2 compatible with RC.5.

---

## Traps this codebase has paid for

Most of these have shipped more than once. They are cheap to check and expensive to find.

**SQL and Drizzle**

- **`= any(${jsArray})` in a `sql` template renders a row constructor**, not an array, and fails
  at runtime only. Four occurrences shipped; `verify:relations` scans for the fifth. Use
  `inArray` / `notInArray`, or `any(${sql`array[…]`})`.
- **An outer column interpolated into a correlated subquery loses its table qualification.**
  Drizzle drops the prefix on a single-table select, and Postgres resolves the bare name against
  the *innermost* scope — so it either binds to the wrong column and returns **silently zero**, or
  says *column reference is ambiguous* when the inner query has a join. Four sites; three had been
  returning zero since they were written. **Always spell the prefix out.**
- **A backtick in a comment inside a `sql` template terminates the template**, and a `${…}` in
  that comment interpolates. Prose about a query goes in the JSDoc above it.
- **`sql<T>` is a claim about a value, not a conversion of it.** No parser is applied to a raw
  expression, so `min(checked_at)` typed as `Date` comes back a string. Type it honestly and
  convert once at the boundary.
- **A `count(*)` over a fan-out join gets the numerator right and the denominator wrong**, so the
  ratio is off by exactly the fan-out and looks plausible. Both halves as subqueries.
- **An `or` across two join conditions cannot use an index** — one query degraded to twenty
  minutes. A cross join with the predicate applied afterwards is worse: 454 million distance
  computations. An HNSW index only serves `order by … limit k`, so bound the top-K in a lateral
  with **nothing else inside it** and filter the K rows that come back.

**Counting, coverage and numbers that lie**

- **Measure the gate with the gate.** "Archetype-ready" counted skills where the gate counts
  structures; `stepsBehind` counted majors where half the tracked projects have lived on one for
  years; a near-proxy replacement agreed to within a point and would have swapped a visible
  contradiction for an invisible one.
- **Say which zero it is.** *Not measured*, *not collected*, *nothing found* and *nothing asked
  for* are the same empty list and opposite conclusions. Coverage travels with every count, and a
  command whose job is to decide whether a feature gets built must refuse to print a confident
  wrong answer — `archetypes --blocks` at 1% coverage, `scope --status` above a 25% split share,
  `taxonomy --compare` when its paired set is corrupt.
- **A rate whose denominator answers a different question inverts conclusions.** Label *share*
  against labels-per-skill did it once; distinct-token coverage against reference coverage did it
  again (1.3% versus 52.3%).
- **A writer that never reads its own output back cannot tell you it wrote nonsense.**
  `counts[token] = (counts[token] ?? 0) + 1` on a plain object read through the prototype for one
  corpus skill named `constructor` and wrote a stringified function into a jsonb integer, in 1 of
  50,965 rows, unnoticed for a whole 2.5-hour pass. The hazard is the accumulator, not the word:
  use a `Map`.
- **A drain loop must stop on progress, not on activity.** `versions === 0` cannot see a pass that
  processes its whole slice and completes none of it — the tool resolver ran **776 identical
  passes**. Stop when `remaining` fails to fall, and record *examined* rather than inferring it
  from the absence of output.

**Scanners and checks**

- **A source scan matches its own prose.** Six suites and one hook have flagged a comment
  explaining the rule they enforce. Strip comments, and assemble positive controls at runtime.
- **A regex bounded by `[^"']+` spans newlines**, so an apostrophe in a doc comment matches a
  quote paragraphs later.
- **A check whose condition cannot fail is not a check** — `a.length === 0 || b === b`.
- **A whitelist that matches nothing passes for the wrong reason.** Assert it matched.

**Runtime and platform**

- **ESM hoists imports**, so `process.env.X = …` above a static import runs after the module read
  it. The import must be dynamic. The `pg` pool is a module singleton for the same reason —
  breaking `DATABASE_URL` after first import changes nothing.
- **`pg` attaches no error listener to a client from `pool.connect()`**, which is every
  `db.transaction()`, and `Client._handleErrorEvent` emits unconditionally — an emit with no
  listener throws and takes the process down. Pool-level handler, per-checkout guard, and
  `keepAlive: true` (off by default), because the pipeline spends minutes inside one fetch and a
  NAT drops the silent socket.
- **Retry only what the failure proves.** A connection-class failure before anything was sent is
  retryable; the same error mid-statement may have applied a write. `40001`, `40P01` and `08007`
  are deliberately never retried.
- **Better Auth swallows a failed background send** and answers 200, so a failed OTP looked sent.
  The workaround is a keyed map read back within the same request; `verify:otp` pins the upstream
  behaviour so an upgrade lets the workaround be deleted.
- **`truncate` on a flex or grid child needs `min-w-0`.** `white-space: nowrap` plus
  `min-width: auto` gives the child a min-content width of the whole string, which widens every
  ancestor. It looks like a clipping bug and is the opposite.
- **`pnpm typecheck` must run `next typegen` first.** `PageProps`/`LayoutProps` are generated into
  `.next`, so a clean checkout fails where every developer machine passes. To reproduce a CI
  failure locally, remove `.next` **and** `tsconfig.tsbuildinfo`.
- **`pnpm verify:tree` is the only check that reads what git has** rather than the working copy.
  It has caught `git add -u` shipping a modified file that imports a new one twice.

---

## Commands

Day-to-day operation and "is it stuck" live in `specs/pipeline-commands.md`. This is the short
list. **Two commands spend real money by design** — `taxonomy --sample` and
`validate --consistency` — plus the metered analytics runs marked below.

```
pnpm dev | build | lint | typecheck
pnpm db:generate | db:migrate | db:studio | db:audit | db:verify-rls

# Pipeline — bounded, resumable, free
pnpm pipeline --status                 # is it stuck? one line
pnpm pipeline                          # sync → validate → fingerprint → signatures → cluster
pnpm pipeline --loop 40 --skip-sync    # catch the derived stages up
pnpm crawl | promote | sync | validate | duplicates | rescan --status
pnpm seed --status | --repos | --lists
pnpm registry --status | --import
pnpm submit <repo-url|owner/name> [--include workspaces/,packages/]

# Derived data — free unless marked
pnpm structures --extract 500 --drain      # fingerprints AND blocks
pnpm structures --probe 400 --tools        # DRY: reads real bundles, writes nothing
pnpm structures --resolve-tools --drain    # token counts → skill_tools
pnpm archetypes --mine-all | --blocks | --tools | --parameters
pnpm blocks --library <category> [--type X] [--tool git]
pnpm taxonomy --status | --sweep | --resync
pnpm taxonomy --sample 100                 # COSTS MONEY (~$0.29/100)
pnpm embeddings --backfill 5000 --drain    # COSTS MONEY (~$0.08 for the corpus)
pnpm scope --status | --run 200 | --calibrate 60      # COSTS MONEY (~$1.04 for the corpus)
pnpm parameters --probe 200 | --status     # free
pnpm parameters --sample 200 | --clusters  # COSTS MONEY (~$1.58 for the corpus)
pnpm relations --status | --filters 100    # free
pnpm relations --conflicts 20              # COSTS MONEY
pnpm links --status | --check 200 | --rotten
pnpm versions --check [--dry] | --status
pnpm lifecycle --status | --deprecate <slug> | --supersede <slug> --by <slug>
pnpm maintainers --status | --grant <email> function review --by <admin-email>

# Verification — 56 suites, free except where marked
pnpm verify:baseline                   # the sweep below, in one command
pnpm verify:tree                       # would a fresh clone build this?
pnpm verify:blocks | verify:archetypes | verify:outcomes | verify:models
pnpm verify:freshness | verify:precision  # the two that read live corpus state
pnpm verify:llm-off                    # no model is reachable when LLM_ENABLED is unset
pnpm verify:*                          # package.json lists them all
pnpm verify:builder                    # COSTS MONEY — two real generations
pnpm verify:trigger --live             # COSTS A LITTLE
pnpm verify:relations --live           # ~$0.002 — proves the detector fires
pnpm walk:loop                         # COSTS MONEY — takes one real skill end to end
```

### Run this first after any reset

Free, read-only, and it establishes the baseline before anything is built on it.

```
pnpm typecheck && pnpm lint && pnpm verify:baseline
```

`verify:baseline` is `db:audit` plus the six suites whose fixtures read the **live corpus** —
`tree`, `models`, `blocks`, `archetypes`, `outcomes`, `freshness`, `precision`. That is the
membership rule, and it is the one worth applying to a new suite: a check whose fixture depends
on corpus state rots as the corpus changes, and rots silently. `verify:freshness` was red for
three days because its backdated probe assumed a corpus with no real link findings — an
assumption that stopped holding the moment the feature it tests was used. The other forty-nine
suites are pure or self-contained and can be run when their subject is touched.
