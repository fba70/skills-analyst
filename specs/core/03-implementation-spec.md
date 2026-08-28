# Skill Foundry v1 — Implementation Spec: Platform & Interface Selection (Doc 3 of 3)

**Author:** TBD · **Date:** 2026-08-27 · **Status:** Draft
**Reviewers:** TBD · **Product spec:** `02-requirements-spec.md` · **Business concept:** `01-business-concept.md` · **Sources:** `04-source-ingestion-analysis.md`
**Changelog:** v1.1 — stack preferences locked (Tailwind + shadcn/ui, Vercel Workflows, AI SDK + AI Gateway); RLS promoted from deferred to in-scope v1 backstop; ingestion aligned with Doc 4

## Summary

We build Skill Foundry v1 on Next.js/Vercel (Node runtime, front + back) with Tailwind CSS + shadcn/ui, Drizzle ORM + Neon Postgres (`pg` over TCP to the pooled endpoint — a deliberate departure from the house HTTP-driver pattern, because this system's multi-write invariants need transactions, and because per-transaction `SET LOCAL` is what makes Postgres RLS enforceable), better-auth for accounts/orgs/API keys, and Cloudflare R2 for skill content with content-addressed keys. All long-running work (source sync, validation, archetype mining) runs on Vercel Workflows fanned out one step per skill, dispatched by cron from database-held schedules. LLM analyzers and the assistant are built on the Vercel AI SDK and route exclusively through the Vercel AI Gateway with runtime-resolved model IDs and hard spend metering. Standard Postgres RLS ships in v1 as the database backstop behind the DAL. The single most important consequence of this design: search, similarity, and analytics all stay inside Postgres (FTS + pgvector + read replica), so v1 ships with exactly four vendors and no self-managed infrastructure.

## Problem

Doc 2 defines a five-subsystem platform (ingest → validate → analyze → build → assist) with a closed feedback loop. The engineering problem is that its workloads have opposing shapes: a latency-sensitive multi-tenant web app; hours-long batch syncs against rate-limited third-party APIs; LLM analysis of *untrusted* content at corpus scale; and append-only, audit-grade data (verdicts, archetypes, events) that must be reproducible years later. **If we do nothing** (build ad hoc, decide platforms per feature), the predictable failures are: sync jobs dying at function timeouts, transaction-less writes corrupting provenance/verdict atomicity, LLM spend without caps, and a tenant-isolation posture discovered rather than designed.

## Goals

Ship Phase 1–2 scope (Doc 2 §10) on ≤4 vendors; every Doc 2 P0 requirement has a designated home in this architecture; validation verdicts reproducible from stored inputs + pinned analyzer versions; corpus-scale jobs survive interruption and re-run idempotently; monthly infra cost at launch scale under $500 excluding one-off backfills, with hard caps on the only unbounded dimension (LLM spend).

## Non-goals

No sandboxed execution of third-party skill code in v1 — the v1 trust boundary is "no ingested code executes anywhere"; the R2.10 sandbox is its own spec (Phase 4, likely a separate egress-denied Worker/Container runner). No Kubernetes, no self-managed queues or search clusters. No BYO-model for users. No multi-region.

## Constraints and assumptions

- **C1 (fixed):** Stack is Next.js on Vercel with Tailwind CSS + shadcn/ui, Drizzle + Neon Postgres over the TCP adapter (transactions + RLS required), Vercel Workflows for durable jobs, Vercel AI SDK + AI Gateway for all model access, better-auth, Cloudflare R2 — chosen by owner preference and operational simplicity; this spec selects *within* it and justifies any departure from house defaults.
- **C2 (fixed):** Vercel request/response cap 4.5 MB; functions ≤800 s — anything potentially longer is a Workflow, never a request.
- **C3 (fixed):** All ingested content is untrusted input, including to LLM analyzers (Doc 2 R7.3).
- **C4 (revised):** Tenant isolation is defense-in-depth from day one: DAL-enforced scoping as the primary boundary, plus standard Postgres RLS as the database backstop — least-privilege runtime role and per-transaction `SET LOCAL app.org_id` plumbing land with the schema; policy coverage on all org-scoped tables gates the first private-corpus tenant.
- **A1 (assumption):** Launch scale ~100K indexed skills, 2K changed/week, 500 assistant sessions/mo, <10 paying orgs in the first two quarters. Design decisions get re-checked at 10× (noted inline).
- **A2 (assumption):** GitHub is ≥80% of ingestion volume; its REST/GraphQL rate limits (5K req/hr/token) are the sync throughput ceiling.
- **A3 (assumption):** A cheap analyzer-class model at ≤$0.50/M input tokens remains available via the Gateway; R2.3 consistency checks cost ~6K tokens/skill.

## Proposed design

### Component map and flow

```
                    ┌──────────────── Vercel (Node, single region, co-located w/ Neon) ─────────────┐
 GitHub / registries│  Cron dispatcher ─▶ Sync workflow ─▶ per-skill steps ─▶ Validation workflow    │
        ▲           │        │                (fetch/normalize/hash)      (rules → LLM analyzers)    │
        │ webhooks  │        ▼                                                                       │
        └───────────│  Next.js app: registry UI · builder · assistant · Verdict API (route handlers) │
                    └───────┬───────────────┬───────────────────────┬────────────────────────────────┘
                            │ pg/TCP pooled │ S3 API                │ AI Gateway (all LLM traffic)
                       Neon Postgres    Cloudflare R2          Vercel AI Gateway
                       (+ read replica)  (3 buckets)           (runtime-resolved models, budgets)
```

A request flows: browser → Next.js route/server component → DAL in `src/server/` (session → org → scoped query) → Neon. A sync flows: cron → dispatcher reads `sources` schedules from Postgres → durable sync workflow per source → fan-out one durable step per changed skill → each step writes R2 + Postgres in one transaction → enqueues a validation workflow per new `skill_version`. Archetype mining is a weekly workflow reading the **read replica** and appending an immutable `archetypes` row.

### Data model

Core tables (Drizzle schema; abridged — full DDL in the repo):

```
orgs, users, memberships, api_keys            ← better-auth (+ extensions)
sources(id, org_id NULL=public, kind, config, health, schedule, last_sync)
skills(id, canonical_id, dialect, categories[], status, quality_score, tier)
skill_versions(id, skill_id, content_hash, r2_key, frontmatter jsonb,
               provenance jsonb, license_spdx, synced_at)
verdicts(id, skill_version_id, analyzer, analyzer_version, result,
         evidence jsonb, created_at)           ← append-only
capability_surfaces(skill_version_id, fs_read, fs_write, network, shell, credentials jsonb)
archetypes(id, category, version, skeleton jsonb, stats jsonb,
           exemplar_ids[], changelog, created_at)   ← append-only, versioned
drafts(id, org_id, author_id, archetype_id, content_r2_key, state)
events(id, actor, kind, subject, payload jsonb, at)     ← audit log (Doc 2 R7.1), append-only
telemetry(id, org_id, kind, payload jsonb, at)          ← archetype-learning inputs (R6.2)
embeddings(skill_version_id, vector)                     ← pgvector, dim ≤ 1536
```

Append-only tables (`verdicts`, `archetypes`, `events`) are the reproducibility spine: a verdict is never updated, only superseded by a new row from a newer analyzer version, which is what makes re-scan campaigns (R2.12) targeted re-runs rather than mutations. Indexes worth calling out because they constrain migrations: a partial unique index on `skill_versions(content_hash) WHERE status != 'tombstoned'` for dedup, GIN on the FTS tsvector, and an HNSW index on `embeddings.vector` — all three are `CREATE INDEX CONCURRENTLY` (direct endpoint) once the corpus is non-trivial.

### Platform selections and interfaces — the decisions, one by one

**Database transport: `pg` over TCP to Neon's pooled endpoint.** This departs from the house as-built (`neon-http`) deliberately: ingest atomicity (skill_version + provenance + R2 pointer + event in one transaction), quarantine state transitions, and entitlement writes all genuinely need `db.transaction()`, and this is a greenfield project with no legacy constraint. It also matches Neon's own guidance for Vercel Fluid compute, and it is the RLS enabler: `SET LOCAL app.org_id` only works inside a transaction, so TCP + transactions + RLS form one coherent choice rather than three. Consequences: interactive transactions from day one; Neon's HTTP-only native RLS offering is incompatible and not used — the backstop is standard Postgres RLS under a least-privilege runtime role (never `neondb_owner`, which carries BYPASSRLS), in scope for v1 (C4). Direct (non-pooled) endpoint only for migrations and `CONCURRENTLY` index builds. Connection errors from cold starts get exponential backoff with jitter in the DAL — Neon documents this as required, not optional.

**Migrations:** `drizzle-kit generate` → read the generated SQL → `migrate` on the direct endpoint → commit `migrations/`. `drizzle-kit push` is banned repo-wide (known to propose destructive phantom drops on partial/expression indexes — which this schema has). Expand-migrate-contract on hot tables once the corpus is large.

**Search & similarity: inside Postgres.** FTS (tsvector + GIN) for skill search; pgvector for category classification (R3.1), near-dup detection (R1.4), and exemplar retrieval for the assistant (R5.2); heavy mining and analytics on a Neon **read replica** (compute-only cost, same region) so a runaway archetype query cannot touch the user-facing path. Embedding dimension is capped at 1536 to keep a later Vectorize migration open. Re-check at 10×: pgvector with HNSW at ~1M vectors is fine; full-corpus *mining* queries are the thing to watch, and they're already isolated on the replica.

**Content storage: three R2 buckets by trust level.**
- `skills-public`: validated, license-clean bundles under **content-addressed keys** (`sha256/<hash>/<file>`), served from a Cloudflare **custom domain** (not `r2.dev`, never proxied through Vercel). Content-addressing makes integrity (R2.6) structural — the URL *is* the hash the verdict covers — and immutable keys make CDN caching safe (the cached-404-on-custom-domain trap can't bite because keys are never reused).
- `skills-quarantine`: private; curator access only, via session-gated Vercel proxy routes.
- `drafts`: private; builder drafts and org-private skills, session-gated proxy routes with DAL entitlement checks. Never presigned to the client for private-tier content.

No skill content transits a Vercel function body (4.5 MB cap; asset-bearing bundles exceed it): sync workers write to R2 via the S3 API; builder uploads go browser → presigned PUT (S3 endpoint — presigned URLs don't work on custom domains, which is fine, uploads don't use one).

**Job execution: Vercel Cron dispatcher + Vercel Workflows, fan-out one step per skill.** The dispatcher (Vercel Cron, 15-min tick) reads schedules from `sources` — cadence is data, not deploys — writes a heartbeat event, and launches Vercel Workflow runs. The open crawl (Doc 4 §4) runs as resumable code-search shards, each shard a workflow with a coverage-ledger row, so a weeks-long crawl survives deploys and rate-limit pauses. Idempotency key for a sync step is `(source_id, path, commit_sha)`; at-least-once redelivery is safe by construction. Validation workflows chain per skill version: cheap rule-based analyzers and secret scanning in-step, then LLM analyzers. Do not collapse the fan-out: per-item steps are what make hour-scale corpus jobs survivable and resumable. Cloudflare Queues and Inngest-class engines were considered and rejected (see Alternatives); Vercel Workflows is the committed choice.

**LLM access: Vercel AI SDK + AI Gateway only, no raw provider SDKs.** Analyzers are AI SDK structured-output calls; the assistant is an AI SDK agent loop. Model IDs resolve at runtime from a config table (analyzer model swap = config change, and every verdict records analyzer + model version, keeping re-scans targeted). Analyzer prompts treat skill content as data (C3): hardened prompt structure, structured output with schema validation, and *a schema-validation failure is itself a quarantine reason* — an analyzer that got prompt-injected into free-text is detected by its own output shape. The assistant runs with explicit `stopWhen` bounds and a closed tool surface (retrieve archetype, retrieve exemplars, similarity report, lint draft). Gateway budgets are soft caps checked at request start, so the hard stop is our own per-org metering counter (RC.2), checked before each call.

**Frontend & UI: Tailwind CSS + shadcn/ui.** Server Components by default; client components only where interactivity requires. shadcn components are vendored into the repo (owned code, not a dependency), themed via CSS variables to the brand palette (navy `#1E2761`, mint `#02C39A`, ice `#CADCFC`) so product and pitch materials share one identity; Tailwind stays on core utilities with tokens defined once in the theme. The trust surfaces get first-class components (VerdictBadge, CapabilitySurface, ProvenanceCard) — they are the product's identity and will later be embedded by Verdict-API consumers.

**Auth: better-auth with `organization` and `api-key` plugins.** Orgs/memberships carry tenancy and entitlements; API keys authenticate the Verdict API with per-key rate limits and metering. Core and plugins pinned to exact matching versions, bumped together in one edit — mismatched `@better-auth/core` copies crash at startup. GitHub OAuth is the primary login: it's the audience, and it yields the GitHub identity needed for attribution and the later verified-publisher program (R2.14). The auth boundary is the DAL in `src/server/`, called from every read path; middleware is an optimization, never the boundary (Server Actions are POSTs that can silently escape a matcher — every action re-checks session + org). Any function taking an explicit `organizationId` lives in a `server-only` module, never `"use server"`.

**Public interfaces (v1):**
- **Web app** (registry, builder, assistant) — session-authed.
- **Verdict API** (`GET /api/v1/verdicts/{content_hash}`, `GET /api/v1/skills/{id}`) — API-key authed, metered, versioned from day one because third parties will build on it; responses carry `analyzer_version` so consumers can pin.
- **Submission endpoint** (`POST /api/v1/sources`) — authed, feeds the same intake pipeline.
- **Connector SDK** (Apache-licensed package): a connector implements `enumerate(source, cursor) → changed[]` and `fetch(ref) → bundle`; the pipeline owns normalization, hashing, and writes, so a community connector never touches storage or the DB directly — which is both the security boundary and what makes connectors easy to review.

### Tenant isolation

Shared tables + `org_id`, with two enforcement layers shipping together. Layer 1, the DAL: every query resolves the org from the better-auth session; any function taking an explicit `organizationId` is `server-only`. Layer 2, standard Postgres RLS as the database backstop: the app connects as a least-privilege runtime role; every DAL entry point opens a transaction and issues `SET LOCAL app.org_id = <session org>`; policies on org-scoped tables allow `org_id IS NULL` (public corpus) or `org_id = current_setting('app.org_id')::uuid`. Public-corpus reads remain the safe common case; risk concentrates in Team-tier private corpora, which is why entitlements (RC.1), DAL scoping, and RLS policy coverage ship as one unit — policy coverage is the launch gate for the first private-corpus tenant, and until then RLS runs in place on the tables that exist, so the backstop is exercised continuously rather than bolted on under deadline.

### State and consistency

Skill content in R2 is immutable per key; Postgres rows point at hashes, so a stale read can show an old *version*, never torn content. Archetypes and verdicts are append-only — readers pin a version. The only eventually-consistent surface is search indexing lag after ingest (seconds; acceptable). Nothing tenant-scoped is ever cached on a shared key; framework caching is conservative in v1 (public skill pages may use ISR keyed by content hash, which is immutable — everything else dynamic).

## Alternatives considered

**Do nothing / assemble per feature.** Rejected in the Problem section: the failure modes are predictable and expensive, and a closed-loop system is exactly the kind where per-feature platform drift compounds.

**Fork an existing OSS skills marketplace and extend it.** Plausible — existing projects already do source sync and browsing. Rejected because the differentiating subsystems (verdict reproducibility, archetype mining, the telemetry loop) are the majority of the work and would fight a codebase designed as a catalog; and adopting someone else's stack forfeits C1. We *do* adopt their lessons: awesome-list parsing, dialect plurality, sync-health surfacing.

**Cloudflare-first (Workers + Queues + D1/Hyperdrive + Vectorize).** Genuinely attractive for the pipeline: Queues fit fan-out, Workers are cheap at volume, R2 is already in the picture. Rejected for v1 on operational-simplicity grounds: it splits the codebase across two runtimes and two deploy systems for a small team, D1 can't be the system of record for this schema, and Hyperdrive-to-Neon adds a config surface (two configs, cached and uncached) we don't need yet. The design keeps the door open: embeddings ≤1536 dims (Vectorize ceiling), connector SDK runtime-agnostic, and the future sandbox runner (R2.10) lands on Cloudflare anyway.

**Neon HTTP driver (`neon-http`), matching the house as-built.** Rejected for this project: the known consequence is no interactive transactions, and hand-rolling guarded single-statement invariants across ingest atomicity, quarantine transitions, and entitlements would recreate — from day one and by choice — the most expensive constraint the house stack ever accepted. It would also foreclose the `SET LOCAL`-based RLS backstop now in v1 scope. The house's own checklist recommends `pg`/TCP-pooled for Fluid compute; we follow the checklist over the as-built.

**Inngest-class durable-execution engines vs Vercel Workflows.** Inngest offers richer per-step observability and a mature local-dev story; Vercel Workflows is platform-native (no extra vendor, no signing-key plumbing) and the owner's preference. Committed: Vercel Workflows. Residual risk — the younger product — is contained by design: all state lives in Postgres, steps are idempotent by key, and the workflow layer holds no business data, so a future engine migration is re-plumbing, not a rewrite.

**Dedicated vector DB / managed search (Pinecone, Typesense, etc.).** Rejected at v1 scale: pgvector + FTS covers R3.1/R1.4/R5.2 needs inside the existing vendor, and the read replica isolates the heavy queries. Revisit if similarity latency degrades past P95 300 ms at ~1M embeddings or mining windows blow past the weekly budget.

**Buy validation (VirusTotal-class scanning only).** Signature scanning is necessary but is precisely the blind spot the market already has: it cannot check description-behavior consistency (R2.3) or produce capability surfaces (R2.4), which are the product's trust differentiators. We integrate signature feeds *inside* our rule layer rather than outsourcing the verdict.

## Failure modes

| Dependency | Slow | Down | Wrong data |
|---|---|---|---|
| Neon primary | DAL backoff+jitter; UI degrades honestly | App down (accepted: single region, no HA claim in v1); workflows pause and resume | Restore window (Scale tier, 14 days) + append-only spine limits blast radius; events table is the reconstruction path |
| Neon read replica | Mining runs long; alert if weekly window exceeded | Mining skipped this cycle — archetypes go stale, which is safe (versioned, loop alerts per R6.4) | Replica lag can't corrupt: mining reads are statistical and versions are pinned |
| Cloudflare R2 | Skill pages render metadata without content preview | Public serving down (custom domain); ingest steps retry — durable steps make this a pause, not data loss | Impossible for content by construction: content-addressed keys mean a wrong object fails hash verification at write time |
| GitHub API | Sync throughput drops; token pool + backoff; source-health dashboard shows starvation rather than silence | Sync pauses; corpus staleness alert at 24 h (R7.4) | Force-push/deletion detected by hash drift → `revalidating` state; prior version stays served until the new one passes (R1.5) |
| AI Gateway / models | Validation queue grows (visible metric); assistant streams a wait state | Rule-based analyzers still run; LLM verdict tiers marked `pending` — skills cap at a lower trust tier rather than passing unvalidated (**fail closed**) | The one that hurts: a confidently wrong analyzer verdict. Mitigations: schema-validated structured output, quarantine-precision spot-checks (target ≥90%), appeal path, analyzer-versioned re-scans. A poisoned/hijacked analyzer output that breaks schema is itself a quarantine signal |
| Cron dispatcher | — | All ingestion stops for everyone: heartbeat event + external uptime check on staleness; runbook, no pretend pager rotation | Misread schedule ⇒ wrong cadence; schedules are rows with audit events, so diffable and reversible |
| Billing webhooks | Entitlement lag; grace period, never mid-session lockout | Entitlements frozen at last known state | Idempotent entitlement writes tolerate duplicates/replays (RC.4) |

Blast radius note: public corpus surfaces degrade globally but read-only; the only per-tenant destructive surface is private-corpus ingestion, which is why it ships last (Phase by tier).

## Cost

| Dimension | Unit cost | Assumed volume (A1) | Monthly |
|---|---|---|---|
| R2 storage + ops | $0.015/GB-mo; Class A $4.50/M | 5 GB; ~40K writes | < $5 |
| Neon (primary + replica) | compute-hours | 1–2 CU working set, scale-to-zero off-peak | $50–150 |
| Vercel Pro + workflows | per-invocation + duration | cron ticks + ~10K workflow steps/wk | $20–100 |
| LLM — incremental validation | ≤$0.50/M in (A3) | 2K skills/wk × 6K tok | $20–60 |
| LLM — assistant | mixed | 500 sessions × ~80K tok | $50–200 |
| LLM — backfill (one-off) | ≤$0.50/M | 100K skills × 6K tok = 600M tok | $200–600 once |
| Embeddings backfill (one-off) | ~$0.02/M | 100K × 1K tok | < $10 once |

**At 10×:** every line stays boring except LLM validation — a full-corpus re-scan at 1M skills is $2–6K *per campaign*. Caps that stop accidental spend: per-org caps (RC.2), a separate global analyzer budget with alerting, and the design rule that re-scans are rule-triggered *slices* by default, full-corpus only by explicit decision.

## Security and privacy

Three data classes: public corpus content (untrusted; treated as data everywhere including analyzer prompts, C3); user/org account data (better-auth tables, DAL-scoped); Team-tier private skills (highest sensitivity — private R2 bucket, session-gated proxy, DAL entitlements, and the RC.5 guarantee that private corpora never influence public archetypes). What leaves our infrastructure: skill content and drafts reach model providers via the Gateway — retention posture (per-request zero-data-retention vs. team-wide) is decided before the first enterprise security review (open question OQ-3), and telemetry spans default to `recordInputs: false`. Verdict evidence may quote malicious payloads; curator UI renders it inert (no execution, no live links). GDPR (Vienna-based operator): erasure covers Postgres rows, R2 drafts, telemetry, and provider-side retention; public *corpus* content is out of GDPR scope but has the takedown workflow (R7.5). Secrets found by scanning are stored as fingerprints, never plaintext.

## Observability

Dashboards, in priority order: source-health (per-source last-sync, error rate, rate-limit headroom — starvation must be visible, not silent); validation pipeline (queue depth, verdicts/hr, quarantine rate, quarantine-precision spot-check results); loop health (archetype version cadence, telemetry volume, bounded-delta rejections — R6.4); spend (per-org LLM meters vs. caps, global analyzer budget burn). Alerts: dispatcher heartbeat stale >30 min; corpus staleness >24 h; analyzer schema-failure rate >2% (signals model drift or injection wave); global LLM budget at 80%. Every state transition is an `events` row, so any incident is reconstructible by query — that's the audit log doing double duty as observability of record.

## Rollout

Staged by trust exposure, matching Doc 2 phasing: (1) internal — ingest a curated 20-source allow-list, validation on, UI behind auth, verdicts visible to team only; (2) public read-only — registry + verdicts public, submissions open, builder behind a flag; (3) authoring GA — builder + assistant public with free-tier quotas; (4) paid tiers + Verdict API with design partners. Watch at each stage: quarantine precision (gate to stage 2: ≥90% on spot-check), first-pass validation rate for builder skills (gate to stage 3 wide release: ≥80% on internal use). **Rollback:** the app deploys roll back trivially (Vercel); data does not need to — append-only verdicts/archetypes mean a bad analyzer or a bad archetype version is *superseded*, not unwound; the one hard-to-reverse surface is public verdict exposure on a skill later found misjudged, which is why the appeal path and supersede-with-notice mechanism ship in stage 1, not later. Migration discipline (expand-migrate-contract) keeps schema rollbacks possible through stage 3.

## Testing

Automated from day one (deviating from the house no-CI posture deliberately — the validation pipeline *is* the product's trust claim): analyzer rule packs ship with fixture corpora of known-bad skills (exfiltration patterns, hidden-Unicode injection, description/behavior mismatch) and known-good ones; the bounded-delta function (R6.5) is a pure function with property tests; DAL tenant-scoping has tests that fail if any query path lacks org resolution; connector SDK ships a conformance suite third-party connectors must pass. Manual pass: curator quarantine UX, appeal flow. Verifiable only in production: quarantine precision on real corpus diversity, GitHub rate-limit behavior under token pooling — both have dashboards and stage gates instead of pretend pre-prod coverage. The thing I'm most worried about: **R2.3 consistency-check false positives at corpus diversity** — detected by the precision spot-check metric, mitigated by the appeal path and per-analyzer-version supersession.

## Work breakdown

Rough sequence, sized in ideal engineer-weeks for a 2–3 person effort: repo + Vercel/Neon/R2/better-auth scaffold with DAL pattern and migrations discipline (1–2 w); schema + connector SDK + GitHub connector + sync workflows (3 w); rule-based validation + quarantine + events spine (2 w); LLM analyzers via Gateway + verdict model + re-scan slices (3 w); registry UI + search/FTS + embeddings/categorization (3 w); archetype mining v1 + read replica (2 w); builder + scaffolding (3 w); assistant loop + retrieval tools (3 w); telemetry + bounded-delta + loop dashboard (2 w); tiers/metering/billing + Verdict API (3 w). ≈ 25–27 engineer-weeks to end of Phase 3 scope — sanity check, not a plan.

## Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| 1 | ~~Durable workflow engine~~ **Resolved: Vercel Workflows** (owner decision; see Alternatives). Remaining 1-day spike: verify per-step retry semantics and the local-dev loop against the sync design | Eng | Before sync build |
| 2 | Embedding model + exact dimension (≤1536) and whether categorization uses embeddings-only or embeddings + LLM adjudication for low confidence | Eng | Before analytics build |
| 3 | Gateway data-retention posture (per-request ZDR vs team-wide) and which analyzer models are approved for untrusted-content processing | Eng+Legal | Before public ingest |
| 4 | Read-replica sizing and whether mining needs its own compute schedule (scale-to-zero interaction) | Eng | Phase 2 |
| 5 | Verdict API shape review with first design partner (hash-keyed lookup vs batch vs webhook push) | Product | Before API GA |
| 6 | ~~RLS spec scheduling~~ **Resolved: in v1 scope** — least-privilege role + `SET LOCAL` plumbing land with the schema; policy coverage gates the first private-corpus tenant (C4) | Eng | Schema build |
| 7 | GitHub code-search shard design + GH Archive/BigQuery as bulk enumerator alternative (Doc 4 OQ-S4) | Eng | Before open crawl (wave 3) |
