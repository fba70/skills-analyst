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

### The ingest schedule (R1.7)

`vercel.ts` runs `/api/cron/pipeline` every ten minutes; the route runs one bounded pass and
returns what it did. That is the whole scheduler — no queue, no worker, no state machine.
Every stage is already resumable and idempotent, so "run a slice periodically" is a complete
implementation rather than a placeholder for one.

The cadence follows from arithmetic, not taste: two sources a pass, ~260 passes for the
sources awaiting a first sync, about two days of unattended catch-up. After that the same
schedule holds the corpus inside R7.4's 24-hour freshness target, because a pass with
nothing to fetch is one cheap query per stage and returns immediately. Faster would overlap
— a pass can run minutes, and two fetching the same sources would race each other's writes.

**Two sources per scheduled pass, against five for a manual run.** A cron pass has a ceiling
it cannot negotiate with, and being cut off mid-stage loses every stage behind it, so the
scheduled path trades throughput for reliably finishing.

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
pnpm db:verify-rls  # after ANY schema change that adds an org-scoped table

# Pipeline, each bounded and resumable
pnpm pipeline                        # sync → validate → fingerprint → signatures → cluster
                                     # (also runs on a 10-minute cron in production)
pnpm pipeline --loop 40 --skip-sync  # catch the derived stages up
pnpm rescan --status | --run 300     # R2.12 campaigns; free, rules only
pnpm crawl | promote | sync | validate | duplicates   # the individual stages
pnpm seed --status | --repos | --lists    # curated discovery (Doc 4 §4 steps 1-2)
pnpm submit <repo-url|owner/name> [--include workspaces/,packages/]
pnpm validate --consistency --limit 10   # R2.3 audit — COSTS MONEY, capped at 100/run
pnpm structures --extract 500        # structural fingerprints — free, no model
pnpm taxonomy --sample 20            # categories — COSTS MONEY, capped at 100/run
pnpm taxonomy --status | --review | --resync
pnpm verify:lists | verify:revocation | verify:export | validate:verify | db:verify-rls
```

**Two commands spend money: `pnpm taxonomy --sample` and `pnpm validate --consistency`.**
Both are opt-in, both are capped, and neither runs as part of any default pass. It calls a model once
per skill. Everything else in the pipeline is rules. Treat it as a sampling tool: label a
small batch, read the labels, fix an ambiguous category description in `vocabulary.ts`, run
again. `MAX_BATCH` in `src/server/taxonomy/classify.ts` is a fuse, not a setting.
