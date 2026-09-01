# Skill Foundry — Requirements Specification (Doc 2 of 3)

**Status:** Draft v1.0 · **Date:** 2026-08-27 · **Owner:** TBD
**Companion documents:** `01-business-concept.md` (vision, incentives, monetization, licensing) · `03-implementation-spec.md` (architecture, platform & interface selection) · `04-source-ingestion-analysis.md` (source taxonomy, registry assessments, license chain, Phase-0 waves)
**Changelog:** v1.4 — the ordered plan moved into §10 from CLAUDE.md, so status and plan sit together · v1.3 — §10b implementation status restored and re-audited against the running system on 2026-09-01 · v1.1 — R1.1/R1.4/R1.6 sharpened from the source analysis (Doc 4) · v1.2 — §7.7 MCP access surface added (search shipped; create-skill as paid tool)

> Scope of this document: functional and non-functional requirements for the platform. The *why and the money* live in Doc 1; the *how on our stack* lives in Doc 3. Where a requirement here depends on a commercial decision (tiers, gating) it references Doc 1 rather than restating it.

---

## 1. Problem Statement

The agent-skill ecosystem has reached marketplace scale (registries index 30K–290K skills each), but the ecosystem is split into two disconnected halves: **registries/aggregators** that collect and categorize skills, and **skill creators/wizards** that generate new ones. Nothing transfers knowledge between them — builders don't learn from what the corpus shows works per category, and registries don't feed structural insight back into creation. Meanwhile, empirical audits show ~26% of openly published skills contain at least one vulnerability, so anyone aggregating skills at scale without a validation layer is redistributing risk.

**Cost of not solving it:** skill authors reinvent structure per skill with inconsistent quality; teams importing skills inherit supply-chain risk; the collective knowledge embedded in hundreds of thousands of published skills stays unmined.

## 2. Product Vision (one paragraph)

A platform that (a) continuously ingests skills from multiple open sources, (b) validates them for quality and security, (c) analyzes the corpus to learn category taxonomies and *structural archetypes* — what good skills in each category actually look like, (d) offers a builder that scaffolds new skills from those learned archetypes, and (e) provides a conversational assistant that guides authors through creation using corpus knowledge and user feedback — then feeds the resulting skills and their real-world performance back into the corpus. **The loop is the product.**

## 3. Goals

1. **G1 — Trusted corpus:** ≥95% of skills surfaced to users have passed automated security + quality validation; zero known-malicious skills served.
2. **G2 — Learned structure:** For each top-level category, the system maintains a data-derived structural archetype (sections, resource layout, frontmatter patterns, script conventions) refreshed at least weekly.
3. **G3 — Better authoring:** Skills created via the builder/assistant pass validation on first attempt ≥80% of the time (vs. a measured baseline of hand-written skills).
4. **G4 — Closed loop:** ≥60% of builder sessions use at least one corpus-derived suggestion (archetype, exemplar, or anti-pattern warning), and post-publication telemetry from created skills measurably updates archetypes within one refresh cycle.
5. **G5 — Attribution integrity:** 100% of indexed skills carry provenance (source repo, author, license, content hash, sync timestamp).

## 4. Non-Goals

- **Not a runtime/execution platform.** We don't run skills; we index, analyze, validate, generate. (Separate initiative; huge sandboxing scope.)
- **Not a general MCP server registry.** MCP servers are adjacent but a different artifact class with different trust semantics. (v2 candidate.)
- **Not a paid marketplace with billing/licensing enforcement.** We record licenses and surface them; we don't monetize or enforce. (Premature.)
- **Not a hosting service for private enterprise skill repos** in v1. Design must not preclude it (see P2), but multi-tenant private corpora are out of scope.
- **No human review board in v1.** Validation is automated + community flagging; a curated "verified" tier with human review is a later layer.

## 5. Personas & User Stories

**Personas:** *Skill Author* (builds skills for their team/agents), *Skill Consumer* (finds and installs skills), *Platform Curator* (operates ingestion & validation), *Ecosystem Researcher* (studies the corpus).

Priority-ordered:

- As a **skill author**, I want to start a new skill by picking a category and target platform and receive a corpus-derived skeleton, so that I don't design structure from scratch.
- As a **skill author**, I want an assistant that interviews me about my workflow and drafts SKILL.md content, suggesting sections and trigger phrasing based on what works in similar skills, so that my first draft is close to publishable.
- As a **skill author**, I want my draft validated (structure, security, description-behavior consistency) before export, so that I ship safely and don't get rejected downstream.
- As a **skill consumer**, I want every skill to show provenance, license, validation verdicts, and a risk score, so that I can make an informed install decision.
- As a **skill consumer**, I want search and browse across categories with quality-ranked results, so that popularity doesn't outrank safety.
- As a **platform curator**, I want to add/remove sources (GitHub repos, awesome-lists, registries) and see sync health, dedup stats, and quarantine queues, so that the corpus stays clean.
- As a **platform curator**, I want skills that fail validation to be quarantined with a machine-readable reason, not silently dropped, so that decisions are auditable.
- As an **ecosystem researcher**, I want to query archetypes and their evolution over time, so that I can study how skill conventions change.
- Edge cases: a source removes or force-pushes a skill (must handle revocation & hash mismatch); two sources publish near-duplicates (dedup with canonical attribution); a skill's license is missing or incompatible (index metadata only, don't redistribute content); the assistant is asked to build a skill whose purpose is itself malicious (refuse, log).

## 6. System Overview — The Five Subsystems and the Loop

```
 [1] INGEST → [2] VALIDATE → [3] ANALYZE → [4] BUILD → [5] ASSIST
      ▲                                                    │
      └────────────── publish + telemetry ◄────────────────┘
```

1. **Ingestion & Provenance** — multi-source collection, normalization, dedup, attribution.
2. **Validation Pipeline** — security + quality gates; the trust boundary.
3. **Corpus Analytics** — categorization, structural mining, archetype extraction.
4. **Skill Builder** — archetype-driven scaffolding + editing + export.
5. **Creation Assistant** — conversational, corpus-aware guided authoring.

The **closing of the loop** is a first-class requirement (§7.6), not a byproduct: created skills, their validation outcomes, and their post-publication signals flow back into the corpus and update the archetypes.

## 7. Requirements

### 7.1 Ingestion & Provenance

**P0**

- **R1.1 Source connectors:** Support at minimum (a) arbitrary GitHub repos, (b) awesome-list parsing, (c) sharded GitHub code-search discovery for SKILL.md-standard packages (resumable shards with a coverage ledger — code search caps results per query), (d) the ClawHub API as the one hosting-registry import. Index registries (skills.sh, SkillsMP, LobeHub) are discovery-and-signal sources only: content is always re-fetched from origin, and popularity/audit signals are used solely via sanctioned interfaces with attribution (source classes and per-registry assessment: Doc 4 §2–3). Pluggable connector interface for adding more.
  - *AC:* Given a configured repo source, when sync runs, then all directory-level skills (SKILL.md + optional scripts/, references/, assets/) are captured as atomic artifacts with commit SHA.
- **R1.2 Normalization:** Parse heterogeneous formats (Anthropic-standard SKILL.md, Claude plugins, OpenClaw skills, Cursor rules, generic AGENTS.md-style instructions) into one canonical internal schema with a `dialect` field.
  - *AC:* A skill from any supported dialect renders in the UI with the same metadata card; unparseable items land in a triage queue with a parse-error reason, never silently dropped.
- **R1.3 Provenance record:** Every artifact stores: source URL, repo, path, author(s), license (SPDX where detectable), content hash per file, first-seen/last-seen timestamps, upstream stars/downloads where available.
  - *AC:* No skill can reach "indexed" state with a null provenance record.
- **R1.4 Deduplication:** Exact-hash dedup plus near-duplicate detection (e.g., MinHash/embedding similarity over SKILL.md body). Fork filtering happens at discovery time (`fork:false` + parent-repo linkage), since forks are the single largest duplicate class in the open crawl. Duplicates cluster under one canonical entry; all sources remain attributed.
  - *AC:* Given two sources with byte-identical skills, when both sync, then one canonical entry exists showing both origins; given ≥90%-similar bodies, then they are linked as a variant cluster.
- **R1.5 Revocation & drift:** Detect upstream deletion, force-push, and content change; changed skills re-enter validation; deleted skills are tombstoned (metadata retained, content withdrawn).
  - *AC:* Given an upstream file whose hash changes, when the next sync runs, then the skill status becomes `revalidating` and the prior version stays served until the new one passes.
- **R1.6 License gating:** License resolution follows the six-step evidence-recorded chain in Doc 4 §5 (frontmatter SPDX field → nearest in-tree LICENSE file → GitHub Licenses API → ClearlyDefined → ScanCode on the prioritized slice → unresolved). Unresolved or non-redistributable (incl. CC-NC/ND, source-available) ⇒ metadata-only indexing (name, description, link out) — such skills still receive verdicts and count in corpus statistics, but their text is never mirrored nor reproduced in archetype exemplars. Licenses are stored as SPDX expressions per skill version; attribution-required licenses render attribution wherever content is shown.

**P1**

- **R1.7 Sync scheduling & rate-limit management** per source (cron, webhooks, token pooling, backoff), with a source-health dashboard.
- **R1.8 Community submission** endpoint (submit a repo URL) with automated intake into the same pipeline.

**P2**

- **R1.9 Private/tenant sources** (enterprise repos) — design the source model so a `visibility` scope can be added without schema migration pain.

### 7.2 Validation Pipeline (Quality & Security) — the trust boundary

Design principle: **validation is layered, evidence-producing, and fail-closed.** Every verdict is stored with the analyzer version that produced it, so verdicts can be re-run when analyzers improve.

**P0 — Security layers**

- **R2.1 Static analysis of bundled code:** Scan scripts/ for known-malicious signatures, obfuscation markers, credential exfiltration patterns, dangerous syscalls/network egress, and hardcoded secrets. Multi-engine (signature-based + rule-based, e.g. Semgrep-class rules for skill-specific patterns).
  - *AC:* A skill containing a script that posts environment variables to an external URL is quarantined with reason `exfiltration-pattern`, and the specific line evidence is stored.
- **R2.2 Prompt-injection & instruction-hijack scan of natural-language content:** Detect embedded instructions that target the *consuming agent* rather than describing the skill (e.g., "ignore previous instructions", covert tool-invocation directives, hidden text/Unicode tricks, instructions to disable safety or contact external endpoints).
  - *AC:* A SKILL.md containing zero-width-character-hidden directives is flagged `hidden-instruction` and quarantined.
- **R2.3 Description–behavior consistency check:** LLM-assisted cross-examination of whether the SKILL.md documentation faithfully represents what bundled scripts do (the known blind spot of artifact-level scanning). Output: consistency score + list of undocumented capabilities.
  - *AC:* A skill described as "formats markdown" whose script also opens network sockets receives `undocumented-capability: network` and cannot be listed above quarantine tier.
- **R2.4 Composition-risk metadata:** Record each skill's *capability surface* (file read/write, network, shell, credentials touched) as structured metadata so downstream consumers/agents can reason about risk when combining skills. (Full chain-analysis is P2; capturing the per-skill surface is P0.)
- **R2.5 Quarantine workflow:** Fail-closed. Any failed check → `quarantined` with machine-readable reasons; quarantined skills are invisible to search/build/assist but visible to curators. Re-validation on upstream fix. Community flagging feeds the same queue.
- **R2.6 Integrity:** Content-hash lockfile semantics — what a consumer exports/installs is bit-identical to what was validated. Any served bundle carries its validation report hash.

**P0 — Quality layers**

- **R2.7 Structural lint:** Frontmatter completeness (name, description), description length/specificity, SKILL.md size budget with progressive-disclosure check (oversized monoliths flagged; references/ encouraged), broken internal links, orphaned resources.
- **R2.8 Trigger-quality heuristic:** Score the description's likely triggering precision (specific verbs/nouns vs. vague marketing language); flag collision risk with popular existing skills in the same category.
- **R2.9 Quality score:** Composite 0–100 from structure, documentation completeness, resource hygiene, and (where available) upstream signals. Score and sub-scores are public per skill. Ranking in search = f(quality, security tier, relevance) — **popularity alone must never outrank a failed or unscored skill.**

**P1**

- **R2.10 Behavioral smoke-test in sandbox:** Execute bundled scripts in a network-isolated sandbox with canary credentials/files; verify no unexpected egress or canary access. (Gates the "verified" tier.)
- **R2.11 Eval harness integration:** For skills that declare test cases/golden examples, run with-skill vs. without-skill comparisons and store impact metrics (the Skill-Creator-v2 pattern) as part of quality scoring.
- **R2.12 Re-scan campaigns:** When an analyzer rule is added, re-verdict the affected corpus slice within 7 days.

**P2**

- **R2.13 Cross-skill composition analysis:** Model emergent risk when skills are combined into chains (data-thief + hijacker archetypes); requires the R2.4 capability metadata.
- **R2.14 Signed publication / verified-author identity** (Sigstore-class signing).

### 7.3 Corpus Analytics — categorization, attribution, structure mining

**P0**

- **R3.1 Taxonomy:** Hybrid categorization — a curated top-level taxonomy (~20–40 categories: data-analysis, doc-generation, code-review, browser-automation, devops, …) with ML-assisted assignment (embedding classification of SKILL.md), multi-label, with confidence; low-confidence items queued for curator review.
  - *AC:* ≥90% of newly ingested skills receive at least one category with confidence ≥ threshold without human touch.
- **R3.2 Structural archetype extraction (the core novel piece):** Per category, mine validated skills to derive:
  - canonical **section inventory** of SKILL.md (which headings appear, in what order, at what frequency in top-quality skills),
  - **resource-layout patterns** (presence/shape of scripts/, references/, assets/, templates/),
  - **frontmatter conventions** (description length distribution, trigger-phrase patterns, argument hints),
  - **size/disclosure norms** (SKILL.md length vs. references offloading),
  - **anti-patterns** correlated with low quality scores or validation failures.
  - Output: a versioned **Archetype** object per category `{skeleton, section descriptions, exemplar skill IDs, statistics, anti-patterns}`.
  - *AC:* For each category with ≥50 validated skills, an archetype exists, is regenerated weekly, and every element is traceable to the corpus evidence that produced it (exemplar IDs, frequency stats).
- **R3.3 Exemplar selection:** Per category, maintain 3–10 high-quality, license-clean exemplar skills usable as in-context references by the builder/assistant.
- **R3.4 Attribution surfacing:** Category pages and archetypes credit the skills/authors they were derived from.

**P1**

- **R3.5 Trend analytics:** Category growth, convention drift over time (archetype diffing between versions), emerging categories detection (embedding clusters not matching taxonomy → curator proposal).
- **R3.6 Similarity/duplication insight for authors:** "12 similar skills exist; here's how yours differs" report.

**P2**

- **R3.7 Public research API/dataset export** (license-respecting) of archetypes and corpus statistics.

### 7.4 Skill Builder (structured creation)

**P0**

- **R4.1 Archetype-driven scaffolding:** Author selects category + target platform(s) (Claude Code, Cursor, Copilot, OpenClaw, Gemini CLI, …) + purpose statement → system generates a skeleton from the current archetype: pre-filled frontmatter template, section headings with per-section guidance, resource-directory stubs, dialect-correct export format.
  - *AC:* Given category "doc-generation" and target "Claude Code", when the author scaffolds, then the skeleton matches the current archetype version (recorded in the draft's metadata) and passes structural lint empty-of-content.
- **R4.2 Editor with live validation:** Split-pane markdown editing, YAML frontmatter validation, inline lint (R2.7/R2.8) as-you-type, security pre-scan on save.
- **R4.3 Custom user input merge:** Author-supplied context (workflow description, examples, constraints, existing scripts) is incorporated into the scaffold without breaking archetype structure; deviations from archetype are allowed but visibly marked ("non-standard section for this category").
- **R4.4 Multi-dialect export:** One canonical draft → export to selected platform dialects + zip bundle; every export embeds provenance (created-by, archetype version, validation report hash).
- **R4.5 Pre-publish gate:** Full validation pipeline (7.2) runs before export/publish; failures block publish with actionable evidence, author can override only for local export (marked `unvalidated`).

**P1**

- **R4.6 Template wizard for non-experts** (form-driven path to the same skeleton).
- **R4.7 Version history & diff** for drafts; import-and-improve an existing skill (fork with attribution).
- **R4.8 Eval authoring support:** Guided creation of should-trigger/should-not-trigger test queries and golden examples (feeds R2.11).

### 7.5 Creation Assistant (conversational, corpus-aware)

**P0**

- **R5.1 Interview-driven drafting:** The assistant elicits purpose, audience, workflow steps, trigger situations, and failure modes conversationally (the wizard/interview pattern), then drafts SKILL.md content section-by-section into the builder.
- **R5.2 Corpus-grounded suggestions:** At each step the assistant retrieves from the analytics layer: the category archetype, nearest exemplar skills, common trigger phrasings, and relevant anti-patterns — and cites them ("skills in this category almost always include an error-handling section; the top exemplars phrase triggers as imperative verbs").
  - *AC:* Assistant suggestions are traceable — each structural suggestion links to the archetype element or exemplar it came from; the assistant never asserts a corpus fact without a retrievable source.
- **R5.3 Gap detection & topic suggestion:** Given a chosen category, the assistant can propose *what to build*: underserved niches (high search demand / low supply, or cluster gaps from R3.5) and refinement of the author's vague idea into a differentiated scope (using R3.6 similarity report).
- **R5.4 Feedback incorporation:** The author can accept/reject/edit each suggestion; rejections are recorded as structured feedback events (suggestion ID, reason if given).
- **R5.5 Safety refusals:** The assistant refuses to help author skills whose purpose is malicious (exfiltration, agent hijacking, injection payloads) and refuses to weaken validation; refusal events are logged.

**P1**

- **R5.6 Improve-my-skill mode:** Point the assistant at an existing skill (owned or forked) → archetype-gap analysis + guided revision.
- **R5.7 Assistant-driven eval loop:** Assistant proposes test cases, interprets eval results (R2.11), and suggests targeted revisions.

### 7.6 Closing the Loop (first-class subsystem)

**P0**

- **R6.1 Publish-back:** Skills created in the platform enter the same ingestion/validation pipeline as external skills — no privileged path. Their archetype-version lineage is recorded.
- **R6.2 Creation telemetry → archetype learning:** Aggregate, privacy-respecting signals feed archetype refresh: which suggested sections authors keep vs. delete, which archetype elements correlate with first-pass validation success (G3), which exemplars get followed. Archetype regeneration (R3.2) consumes these signals alongside corpus statistics.
  - *AC:* Given ≥N (configurable) builder sessions in a category in a refresh window, when archetype regeneration runs, then acceptance/rejection statistics are inputs and the archetype changelog cites them.
- **R6.3 Outcome telemetry:** Where consumers opt in (or upstream registries expose it), collect post-publication signals — installs, flags, validation status over time, eval-impact scores — and attribute them to archetype versions, so "what good looks like" is grounded in outcomes, not just prevalence.
- **R6.4 Loop observability:** A dashboard showing the loop working: archetype version history, what changed and why (evidence), and G3/G4 metric trends. If the loop stalls (no archetype updates despite signal volume), alert.
- **R6.5 Feedback-poisoning resistance:** Telemetry is rate-limited, deduplicated per identity, and outlier-trimmed; a burst of coordinated feedback cannot move an archetype past a bounded delta per cycle. (The loop is an attack surface — treat archetype inputs like user input.)

**P1**

- **R6.6 A/B archetype evaluation:** Serve candidate vs. current archetype to a fraction of builder sessions; promote on measured first-pass-validation and author-acceptance improvement.

### 7.7 MCP Access Surface (agent integration)

The platform is itself consumed by agents. An MCP server exposes platform functions to any MCP-capable client, making Skill Foundry the in-agent path for discovery *and* creation — which is also the strategic counter to the "just ask the agent" risk: instead of competing with in-agent skill creation, the platform becomes it, with the trust badge as the differentiator.

**P0 — shipped**

- **RM.1 MCP search & lookup:** MCP tools for corpus search and per-skill retrieval (details, verdicts, capability surfaces, provenance, license posture). Available on the **Free tier**, but gated on an **account + API key token** — the programmatic counterpart of RC.1's boundary: *anonymous web access stays free and keyless; agent/programmatic access is free for search but keyed.* Keys are per-user/org (better-auth api-key plugin), rate-limited per key, and metered through the event log (RC.3).
  - *AC:* An MCP client with a valid key can search and retrieve any public skill with trust data identical to the web registry; a request without a key is refused with a sign-up pointer; per-key rate limits hold.
- **RM.2 No bypass:** MCP tools are subject to exactly the same gates as the web: quarantined/metadata-only skills return the same reduced surface, verdicts are never gated (RC.1), and no MCP tool can trigger validation skips, publication, or content the license posture forbids.

**P1**

- **RM.3 MCP create-skill (paid):** an MCP tool that scaffolds and drafts a new skill from inside an agent session — archetype-driven (R4.1), same pre-publish validation gate as the web builder (R4.5). **Paid accounts only** (Pro and above), entitlement enforced in the DAL (RC.1 mechanics), quota-bound under the org's LLM spend cap (RC.2). Drafts created via MCP are org-scoped like web drafts.
- **RM.4 Boundary vs the Verdict API:** MCP lookup is *interactive-scale* (per-key rate limits sized for a human-driven agent session) and free; the commercial Verdict & Archetype API is *bulk-scale* (hash-keyed batch lookups, live feeds, SLA). The rate limits are the boundary — raising them for a key is a commercial conversation, not a config favor.

## 8. Cross-Cutting Requirements

- **R7.1 Auditability (P0):** Every state transition (indexed, quarantined, verified, archetype-updated) is an immutable event with actor, reason, and analyzer/model versions.
- **R7.2 Reproducibility (P0):** Any validation verdict and any archetype can be regenerated from stored inputs + pinned analyzer versions.
- **R7.3 Least-privilege analysis (P0):** All corpus content is untrusted input. LLM-based analyzers (R2.3, R3.x, R5.x) must treat skill text as data — analyzer prompts are hardened against injection from the skills being analyzed, and analyzer outputs are schema-validated before entering the pipeline.
- **R7.4 Performance (P1):** Full-corpus resync detects upstream changes within 24h; search p95 < 500ms at 500K skills; archetype regeneration completes within the weekly window.
- **R7.5 Compliance (P0):** DMCA/takedown workflow; license text preserved and displayed; no redistribution beyond license terms (R1.6).

## 9. Success Metrics

**Leading (days–weeks):**

- First-pass validation rate of builder-created skills (target ≥80%, baseline measured in week 1) — *primary G3 metric.*
- % builder sessions using ≥1 corpus suggestion (target ≥60%) and suggestion acceptance rate (target ≥40%).
- Ingestion coverage: # sources synced, % of known public SKILL.md corpus indexed (target ≥70% of top registries' union in 90 days).
- Quarantine precision: % of quarantines upheld on curator spot-check (target ≥90%; low precision = analyzer noise eroding trust).

**Lagging (weeks–months):**

- Zero confirmed malicious skills served post-validation (hard target: 0; any incident triggers postmortem + rule re-scan campaign).
- Archetype efficacy: first-pass validation rate delta between archetype-scaffolded and blank-start skills (target +25pp).
- Author retention: % of authors creating a 2nd skill within 60 days (target ≥30%).
- External adoption: platform-created skills appearing in third-party registries with intact provenance.

**Measurement:** all metrics from event log (R7.1); evaluated at 2 weeks, 1 month, 1 quarter post-launch per phase.

## 10. Phasing and the ordered plan

*(Architecture homes for each phase are assigned in Doc 3 §Proposed design and §Rollout.)*

- **Phase 1 (foundation):** Ingestion (R1.1–1.6) + Validation P0 (R2.1–2.9) + basic taxonomy (R3.1) + search/browse. *Ship a trustworthy registry first — everything else depends on a clean corpus.*
- **Phase 2 (intelligence):** Archetype extraction (R3.2–3.4) + Builder (R4.1–4.5).
- **Phase 3 (assistant + loop):** Assistant (R5.1–5.5) + closing the loop (R6.1–6.5).
- **Phase 4 (hardening & scale):** Sandbox behavioral testing (R2.10), eval harness (R2.11), composition analysis (R2.13), A/B archetypes (R6.6), verified tier.

Dependency note: R3.2 needs ≥50 validated skills/category → Phase 1 corpus volume gates Phase 2 quality. R6.x needs builder telemetry → Phase 3 by definition.

### The ordered plan — 2026-09-01

Derived from the §10b audit below, which is the status of record. Phases say what depends on
what; this says what to do next and why in this order.

**Ingestion is still the critical path and nothing below changes that.** 472 of 903 sources
have never synced, 2,023 discovery candidates are undecided, and the taxonomy is 11,298
skills behind the corpus. Those three gate the quality of every archetype the product sells.
The list below is what to do *while that runs*.

Ordering rule used throughout: **a thing that unblocks several others outranks a thing that
is merely valuable.** Two items qualify.

---

**1. Finish ingestion.** Not a build task — a wait. `pnpm pipeline --loop 300` in your own
shell until `never_synced` reaches zero, then `pnpm promote --enrich 300 --decide` repeatedly
to work through the 2,023 candidates. Watch that the queue is *shrinking*, because a run that
adds sources faster than it drains them never converges.

**2. Taxonomy catch-up (R3.1) — ~$33, and it unblocks the whole analytics half.**
`pnpm taxonomy --sample 100` until `remaining` is zero. Archetypes read only labelled,
above-floor assignments, so today they rest on about a quarter of the corpus. R3.5, R3.6,
R5.3 and every archetype quality claim sit behind this. **Do it after sync converges, not
during** — labelling a moving corpus means paying twice.

**3. Archetypes v6 (`pnpm archetypes --mine-all`) — free, and the first real read on the
loop.** Only after 1 and 2. Comparing v5 against v6 finally answers how much the sampled weak
band was distorting v5, and whether the 1,235-skill "no sections" cluster is skewing the weak
band. Append-only, lands with a changelog.

**4. Entitlements (RC.1) — the other unblocker.** Absent, and it is the single gate on every
paid surface: RM.3 (MCP create-skill), the paid MCP scope, RC.4 billing, and the Team-tier
private corpus. Nothing is gated today, so the free-tier guarantee holds by construction and
none of the mechanism exists. Until this lands, "paid" is not a feature that can be built —
only described.

**5. Outcome telemetry (R6.3) — the largest single gap in the product.** R6.1, R6.2, R6.4 and
R6.5 are done: a skill authored here is published through the same pipeline, what happened
while authoring it is recorded, and mining consumes it. What is missing is the *outcome* half
— no post-publication signal is attributed to an archetype version. Until it exists, "what
good looks like" is a claim about the corpus, never about results, and G3/G4 measure the loop
running rather than the loop working.

**6. Re-home the lost distribution requirements.** §7.7 was replaced wholesale in the v1.2
rewrite and **R8.1–R8.7 vanished with it** — the public registry, skill export and the corpus
statistics surface are all running with no requirement behind them, and R8.4 (per-version
permalinks, so a verdict can be cited) lost its only written home. Code with no requirement is
as much a gap as a requirement with no code. Cheapest item on this list and the one most
likely to be forgotten.

**7. Author-facing analytics (R3.6 → R5.3).** The dedup data already exists; nothing surfaces
"12 similar skills exist, here is how yours differs" to an author. R3.6 is the small half and
unlocks R5.3's gap detection. Both are gated on taxonomy (2).

**8. Assistant depth (R5.1 conversational, R5.4 per-suggestion feedback).** Today the builder
is a four-step form and R5.4 does not exist — which matters beyond UX: without accept/reject
events there is no structured feedback stream, so R6.2 learns only from what *survived to
publish*, never from what an author rejected outright.

**9. R4.2 live editor and R4.3 deviation marking.** The validation seam
(`runAnalyzersOnBundle`) already takes files rather than a storage key, so as-you-type linting
needs no new analyzer work — this is a UI build on an existing capability.

---

**Deliberately still parked, with the reason:**

- **Embeddings / pgvector** — needed for R3.5 clustering and R5.2 retrieval at scale. Wait
  until the corpus stops moving; vectors built over a half-ingested corpus get rebuilt.
- **R2.10 sandbox, R2.11 eval harness** — Phase 4, and both need infrastructure this project
  does not have. R4.8 and R5.7 depend on R2.11 and inherit the wait.
- **R2.14 verified tier** — blocks R2.9's security-tier ranking term. That term is honestly
  documented as "the filter" until a tier exists to weigh.
- **R1.6 steps 4–5 (ClearlyDefined, ScanCode)** — measured and **not worth building**: 85 of
  the 92 repositories with unresolved licences have no licence at all, which no scanner can
  resolve. Fix the text matcher instead when a licence family is missed.
- **Finishing the code-search crawl** — 38 shards saturated on the size axis. The skills.sh
  reconciliation turned out to be the better second axis: 2,323 new repositories from four
  sitemap fetches, against a crawl that cannot finish.
## 10a. Commercial & Entitlement Requirements (bridge to Doc 1)

The tier structure, pricing, and licensing rationale are defined in Doc 1 §4–5. The platform requirements they impose:

- **RC.1 (P0):** Entitlement checks are enforced in the data-access layer (never UI-only), keyed on org plan. Free-tier trust surfaces — per-skill validation verdicts, provenance, quarantine status — are **hard-coded exempt from gating** and cannot be paywalled by configuration.
- **RC.2 (P0):** Per-org monthly LLM spend caps (assistant + validation), fail-closed with clear UX; a separate global platform budget covers corpus-analyzer spend, with alerting.
- **RC.3 (P1):** Usage metering (assistant tokens, validation runs, Verdict-API lookups) flows through the audit event log (R7.1) so billing is reconstructible and auditable.
- **RC.4 (P1):** Billing-provider webhooks drive entitlement sync; entitlement writes are idempotent and tolerate late/duplicated webhook delivery.
- **RC.5 (P0):** Org-scoped private corpora (Team tier) never feed public archetypes — not even in aggregate — unless Doc 1 open question OQ-C2 is explicitly resolved otherwise.

## 10b. Implementation status — audited 2026-09-01

Read against the running system, not against intent. This table is the source of truth for
"what is built"; the prose above is the source of truth for "what is wanted".

Corpus at audit: **16,273 indexed** (15,061 canonical · 1,212 near-duplicate variants) ·
225 quarantined · 431 of 903 enabled sources synced · 16,542 fingerprints · 16,247 dedup
signatures · 12 archetype categories at v5 · 4,101 skills labelled.

Legend: **done** · **partial** (works, with a named gap) · **absent**.

> **This section was lost in the v1.2 rewrite and is restored here.** Alongside it, §7.7 was
> replaced wholesale — the previous **R8.1–R8.7 Distribution & Access** block is gone, and
> with it the only written requirements for the public registry, skill export and the corpus
> statistics surface. **All three are built and running.** They are recorded at the bottom of
> this table as `R8.x (unspecified)` so shipped behaviour is not invisible, but they need
> re-homing in §7 by whoever owns the spec: code with no requirement is as much a gap as a
> requirement with no code.

### 7.1 Ingestion & provenance

| | | |
|---|---|---|
| R1.1 Source connectors | P0 | **partial** — (a) repos, (b) awesome-lists, (c) sharded code search all done. **(d) ClawHub absent.** Index-registry reconciliation now exists for **skills.sh** via its advertised sitemap (`pnpm registry`), which found 2,422 repositories, 2,323 of them new. |
| R1.2 Normalization | P0 | **done** — five dialects into one schema; parse errors are triaged, never dropped. |
| R1.3 Provenance | P0 | **done** — NOT NULL by schema. |
| R1.4 Deduplication | P0 | **done** — exact-hash plus MinHash/LSH; 1,268 variant links. |
| R1.5 Revocation & drift | P0 | **done** — `pnpm verify:revocation`. |
| R1.6 Licence gating | P0 | **partial** — four of the six chain steps run. **ClearlyDefined and ScanCode have never produced a row**, and measurement says they never would: of 1,968 unresolved skills, 85 repositories holding 1,713 of them have **no licence at all**, which no scanner can resolve. The real gap was step 2 — the text matcher knew no Creative Commons or LGPL bodies, which stranded 187 skills that are now downloadable. |
| R1.7 Sync scheduling | P1 | **done** — schedule is data (`platform_settings`), `pnpm verify:schedule`. |
| R1.8 Community submission | P1 | **partial** — admin submission and Settings → Add source work. **No public endpoint.** |
| R1.9 Private/tenant sources | P2 | **absent** — the `org_id` column exists throughout, so the model is ready. |

### 7.2 Validation

| | | |
|---|---|---|
| R2.1–R2.2, R2.4, R2.6–R2.8 | P0 | **done** — four free analyzers, fail-closed, content-addressed integrity. |
| R2.3 Description consistency | P0 | **done, opt-in** — costs money, so never in a default pass. |
| R2.5 Community flagging | P0 | **absent** — no route from a reader to the quarantine queue. |
| R2.9 Quality score & ranking | P0 | **done** — the ranking function is now `f(quality, relevance)` with a real relevance term (see R7.4). The **security-tier term is the filter**, not a coefficient: only `indexed` skills are ranked at all, and a weighted tier needs a verified tier (R2.14). |
| R2.10 Sandbox smoke-test | P1 | **absent** — Phase 4; needs infrastructure this project does not have. |
| R2.11 Eval harness | P1 | **absent** — Phase 4. |
| R2.12 Re-scan campaigns | P1 | **done** — `pnpm rescan`; the freshness count now matches the runner's own selector. |
| R2.13 Composition analysis | P2 | **absent** |
| R2.14 Signed publication / verified tier | P2 | **absent** — blocks R2.9's tier term. |

### 7.3 Corpus analytics

| | | |
|---|---|---|
| R3.1 Two-axis taxonomy | P0 | **partial** — vocabulary, classifier and review queue all work. **11,298 canonical skills carry no servable label** (4,101 labelled), because classification costs money and is deliberately manual. This is the single largest quality gate in the product. |
| R3.2 Archetype extraction | P0 | **done** — miner 2.1.0, 12 of 13 categories at v5, banded on source trust. |
| R3.3 Exemplars | P0 | **done** — resolved live, withdrawn ones drop out. |
| R3.4 Attribution | P0 | **done** — credited in distinct structures. |
| R3.5 Emerging-category detection | P1 | **absent** — needs embeddings, deliberately deferred. |
| R3.6 Similarity insight for authors | P1 | **absent** — the dedup data exists; nothing surfaces it to an author. |
| R3.7 Research API / dataset export | P2 | **absent** |

### 7.4 Skill builder

| | | |
|---|---|---|
| R4.1 Archetype-driven scaffolding | P0 | **done** — `/build`, four steps, one model call. |
| R4.2 Editor with live validation | P0 | **absent** — no editor; validation runs once, on generate. |
| R4.3 Custom input merge | P0 | **partial** — author context is merged; **deviations are not visibly marked.** |
| R4.4 Multi-dialect export | P0 | **done** — a directory per dialect, byte-identical repeats. |
| R4.5 Pre-publish gate | P0 | **done** — the same analyzers, via `runAnalyzersOnBundle`. |
| R4.6 Template wizard | P1 | **partial** — the builder *is* form-driven; there is no separate simplified path. |
| R4.7 Version history & fork-with-attribution | P1 | **absent** |
| R4.8 Eval authoring support | P1 | **absent** — depends on R2.11. |

### 7.5 Creation assistant

| | | |
|---|---|---|
| R5.1 Interview-driven drafting | P0 | **partial** — a four-step form, not a conversation. |
| R5.2 Corpus-grounded suggestions | P0 | **done** — prevalence and lift reach both the UI and the prompt. |
| R5.3 Gap detection | P0 | **absent** — depends on R3.5/R3.6. |
| R5.4 Feedback incorporation | P0 | **absent** — no per-suggestion accept/reject, so no structured feedback events. |
| R5.5 Safety refusals | P0 | **done** — a field in the structured output, verified against a real malicious brief. |
| R5.6 Improve-my-skill | P1 | **absent** |
| R5.7 Assistant-driven eval loop | P1 | **absent** — depends on R2.11. |

### 7.6 Closing the loop

| | | |
|---|---|---|
| R6.1 Publish-back | P0 | **done** — calls the same `validatePending` external skills use. |
| R6.2 Creation telemetry | P0 | **done** — structure-only signals; mining consumes lift + delta. |
| R6.3 Outcome telemetry | P0 | **absent** — **the largest single gap in the product.** No post-publication signal is attributed to an archetype version, so "what good looks like" remains a claim about the corpus rather than about results. |
| R6.4 Loop observability | P0 | **done** — Settings → Loop, with a stall alert. |
| R6.5 Poisoning resistance | P0 | **done** — four defences, not a flag. |
| R6.6 A/B archetypes | P1 | **absent** — Phase 4. |

### 7.7 MCP access surface

| | | |
|---|---|---|
| RM.1 MCP search & lookup | P0 | **done** — six tools over `mcp-handler`, each a thin wrapper on the same DAL the web uses; free scope, account-gated by a revocable token; per-key rate limits are admin-tunable settings (`pnpm verify:rate-limit`). **Deviates from the spec on one point:** it says *better-auth api-key plugin*, which **does not exist in better-auth 1.7.2**, and that pin is load-bearing. A scoped `mcp_tokens` table is used instead — which is also the better answer, since an MCP token must not be a session. **The spec sentence is the thing that is wrong here, not the code.** |
| RM.2 No bypass | P0 | **done** — structurally: the tools own no queries, so licence posture, takedowns and quarantine apply unchanged. Corpus text also leaves inside a nonce-closed untrusted fence, which R7.3 implies for outbound flow and no requirement states. |
| RM.3 MCP create-skill (paid) | P1 | **absent** — blocked on RC.1; there is no entitlement to check. |
| RM.4 Boundary vs Verdict API | P1 | **done for the free half** — per-key limits exist and are the boundary. The commercial bulk API does not exist. |

### 8. Cross-cutting

| | | |
|---|---|---|
| R7.1 Auditability | P0 | **done** |
| R7.2 Reproducibility | P0 | **done** — analyzer, extractor, miner and taxonomy versions pinned on every derived row. |
| R7.3 Least-privilege analysis | P0 | **done** — and extended outbound: corpus text reaching a caller's agent is fenced and labelled. |
| R7.4 Performance | P1 | **partial** — 24h drift met. Search now has a **`tsvector` + GIN index, `pg_trgm` fuzzy matching and a composite ranking function**, replacing a sequential-scan `ilike`; measured 0.8 ms on a 16K corpus. **The p95-at-500K target remains unproven** — it has never been tested at that scale. |
| R7.5 Compliance | P0 | **done** — takedowns, `pnpm verify:takedown`. |

### 10a. Commercial

| | | |
|---|---|---|
| RC.1 Entitlements in the DAL | P0 | **absent** — no plans exist. Trust surfaces are un-paywalled by construction, so the free-tier guarantee holds; none of the mechanism does. **This is the gate on every paid feature.** |
| RC.2 Per-org spend caps | P0 | **done** — `pnpm verify:spend`. |
| RC.3 Usage metering | P1 | **partial** — every model call is metered; MCP calls are not yet in the ledger. |
| RC.4 Billing webhooks | P1 | **absent** |
| RC.5 Private corpora never feed public archetypes | P0 | **done** — explicit `org_id IS NULL` filters, not RLS alone. |

### Built, but no longer specified

| | |
|---|---|
| R8.1 Public read-only registry | **done** — `(public)` route group; anonymous readers get verdicts, provenance and licence. |
| R8.2 Skill export / download | **done** — byte-identical repeats, receipt with content and report hashes, licence gate before any object is read. `pnpm verify:export`. |
| R8.5 Corpus statistics surface | **done** — `/` and `/dashboard` share one query. |
| R8.4 Per-version permalink | **absent** — a verdict still cannot be cited. |

## 11. Open Questions

**Blocking:**

- **[Legal]** Redistribution posture for permissively-licensed but attribution-required skills — mirror content or metadata-plus-link-out only? Affects R1.6 and storage design.
- **[Engineering]** Canonical internal schema: adopt the Anthropic Agent Skills open standard as the canonical dialect with lossy mappings from others, or a superset schema? Affects every subsystem.
- **[Product]** Identity model for authors/telemetry (anonymous, GitHub-linked, platform accounts?) — gates R6.2/R6.5 design.

**Non-blocking:**

- **[Data]** Minimum corpus size per category before an archetype is trustworthy — 50 is a placeholder; validate empirically.
- **[Engineering]** LLM analyzer cost envelope for R2.3 at full-corpus scale; sampling strategy vs. exhaustive scanning.
- **[Product]** Should quarantine reasons be fully public, or summarized (to avoid handing attackers a bypass oracle)?
- **[Design]** How aggressively the assistant should push archetype conformance vs. author freedom (marked-deviation UX, R4.3).

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Validation false negatives (malicious skill served) | Trust-destroying | Layered scanning, fail-closed, sandbox tier, incident re-scan campaigns, bounded blast radius via capability metadata |
| Validation false positives (noise) | Author/curator fatigue | Quarantine-precision metric, evidence-first verdicts, appeal path |
| Archetype homogenization (loop converges to monoculture) | Ecosystem-level quality ceiling | Anti-patterns ≠ mandates; deviations allowed & tracked; A/B archetypes; diversity metrics in R3.5 |
| Feedback poisoning of archetypes | Corrupted guidance at scale | R6.5 bounded deltas, identity-weighted telemetry, changelog transparency |
| Upstream API rate limits / source churn | Stale corpus | R1.7 token pooling, webhooks, tombstoning, source-health alerts |
| Legal exposure from mirroring | Takedowns, liability | R1.6 license gating, R7.5 takedown workflow, metadata-only fallback |

