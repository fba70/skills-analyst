# Skill Foundry — Requirements Specification (Doc 2 of 3)

**Status:** Draft v1.0 · **Date:** 2026-08-27 · **Owner:** TBD
**Companion documents:** `01-business-concept.md` (vision, incentives, monetization, licensing) · `03-implementation-spec.md` (architecture, platform & interface selection) · `04-source-ingestion-analysis.md` (source taxonomy, registry assessments, license chain, Phase-0 waves)
**Changelog:** v1.3 — §10b implementation status added, audited against the running system on 2026-08-31 · v1.1 — R1.1/R1.4/R1.6 sharpened from the source analysis (Doc 4) · v1.2 — §7.7 Distribution & Access added (public registry, export, install compatibility); R1.5 and R2.6 acceptance criteria sharpened; §7.3 R3.2 evidence rule and §10 phasing note added — all from the Phase-1 implementation review

> Scope of this document: functional and non-functional requirements for the platform. The *why and the money* live in Doc 1; the *how on our stack* lives in Doc 3. Where a requirement here depends on a commercial decision (tiers, gating) it references Doc 1 rather than restating it.

---

## 1. Problem Statement

The agent-skill ecosystem has reached marketplace scale (registries index 30K–290K skills each), but the ecosystem is split into two disconnected halves: **registries/aggregators** that collect and categorize skills, and **skill creators/wizards** that generate new ones. Nothing transfers knowledge between them — builders don't learn from what the corpus shows works per category, and registries don't feed structural insight back into creation. Meanwhile, empirical audits show ~26% of openly published skills contain at least one vulnerability, so anyone aggregating skills at scale without a validation layer is redistributing risk.

**Cost of not solving it:** skill authors reinvent structure per skill with inconsistent quality; teams importing skills inherit supply-chain risk; the collective knowledge embedded in hundreds of thousands of published skills stays unmined.

## 2. Product Vision (one paragraph)

A platform that (a) continuously ingests skills from multiple open sources, (b) validates them for quality and security, (c) analyzes the corpus to learn category taxonomies and *structural archetypes* — what good skills in each category actually look like, (d) offers a builder that scaffolds new skills from those learned archetypes, and (e) provides a conversational assistant that guides authors through creation using corpus knowledge and user feedback — then feeds the resulting skills and their real-world performance back into the corpus. **The loop is the product.**

## 3. Goals

1. **G1 — Trusted corpus:** ≥95% of skills surfaced to users have passed automated security + quality validation; zero known-malicious skills served.
2. **G2 — Learned structure:** For each top-level category, the system maintains a data-derived structural archetype (sections, resource layout, frontmatter patterns, script conventions) refreshed at least weekly. *(the weekly refresh is built and operator-controlled as of 2026-08-31, and ships **disabled** pending a deliberate first run — see §10b.)*
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
  - *AC (added v1.2):* Given a new version that **fails** validation, the previously indexed
    version remains the served version and the skill stays listed. A failing upstream push
    must never withdraw an already-validated skill — otherwise an upstream author can
    de-list a skill in our registry without touching anything we ever approved.
  - *AC (added v1.2):* Deletion detection acts only on a **complete** enumeration of a
    source. A limited, dry, or path-narrowed sync produces a partial view and must never be
    treated as authoritative about absence, or a truncated run silently empties the corpus.
- **R1.6 License gating:** License resolution follows the six-step evidence-recorded chain in Doc 4 §5 (frontmatter SPDX field → nearest in-tree LICENSE file → GitHub Licenses API → ClearlyDefined → ScanCode on the prioritized slice → unresolved). Unresolved or non-redistributable (incl. CC-NC/ND, source-available) ⇒ metadata-only indexing (name, description, link out) — such skills still receive verdicts and count in corpus statistics, but their text is never mirrored nor reproduced in archetype exemplars. Licenses are stored as SPDX expressions per skill version; attribution-required licenses render attribution wherever content is shown.

**P1**

- **R1.7 Sync scheduling & rate-limit management** *(delivered)* per source (cron, webhooks, token pooling, backoff), with a source-health dashboard.
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
- **R2.6 Integrity:** Content-hash lockfile semantics — what a consumer exports/installs is bit-identical to what was validated. Any served bundle carries its validation report hash. *(Depends on R8.2: until an export path exists this guarantee is unexercised.)*

**P0 — Quality layers**

- **R2.7 Structural lint:** Frontmatter completeness (name, description), description length/specificity, SKILL.md size budget with progressive-disclosure check (oversized monoliths flagged; references/ encouraged), broken internal links, orphaned resources.
- **R2.8 Trigger-quality heuristic:** Score the description's likely triggering precision (specific verbs/nouns vs. vague marketing language); flag collision risk with popular existing skills in the same category.
- **R2.9 Quality score:** Composite 0–100 from structure, documentation completeness, resource hygiene, and (where available) upstream signals. Score and sub-scores are public per skill. Ranking in search = f(quality, security tier, relevance) — **popularity alone must never outrank a failed or unscored skill.**

**P1**

- **R2.10 Behavioral smoke-test in sandbox:** Execute bundled scripts in a network-isolated sandbox with canary credentials/files; verify no unexpected egress or canary access. (Gates the "verified" tier.)
- **R2.11 Eval harness integration:** For skills that declare test cases/golden examples, run with-skill vs. without-skill comparisons and store impact metrics (the Skill-Creator-v2 pattern) as part of quality scoring.
- **R2.12 Re-scan campaigns** *(delivered)*: When an analyzer rule is added, re-verdict the affected corpus slice within 7 days.

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
  - *AC (added v1.2):* The ≥50 threshold counts **distinct document structures**, not skills,
    and requires ≥10 distinct sources. Measured on the real corpus, one repository supplied
    2,067 of 2,329 skills and 1,985 of those shared a single generated skeleton — enough to
    clear a raw-count threshold alone and produce an "archetype" that describes one
    generator. Near-duplicate detection (R1.4) does not catch this: the text genuinely
    differs, only the shape is cloned.
  - *AC (added v1.2):* An archetype is stated as the **contrast** between the top and bottom
    quality bands of its category, not the average of the category. A section present in 90%
    of good skills and 90% of weak ones is not guidance; a section present in 80% of good and
    30% of weak ones is. Averaging reproduces the median skill and teaches nothing.
- **R3.3 Exemplar selection** *(delivered)*: Per category, maintain 3–10 high-quality, license-clean exemplar skills usable as in-context references by the builder/assistant.
- **R3.4 Attribution surfacing** *(delivered)*: Category pages and archetypes credit the skills/authors they were derived from.

**P1**

- **R3.5 Trend analytics:** Category growth, convention drift over time (archetype diffing between versions), emerging categories detection (embedding clusters not matching taxonomy → curator proposal).
- **R3.6 Similarity/duplication insight for authors:** "12 similar skills exist; here's how yours differs" report.

**P2**

- **R3.7 Public research API/dataset export** (license-respecting) of archetypes and corpus statistics.

### 7.4 Skill Builder (structured creation)

**P0**

- **R4.1 Archetype-driven scaffolding** *(delivered)*: Author selects category + target platform(s) (Claude Code, Cursor, Copilot, OpenClaw, Gemini CLI, …) + purpose statement → system generates a skeleton from the current archetype: pre-filled frontmatter template, section headings with per-section guidance, resource-directory stubs, dialect-correct export format.
  - *AC:* Given category "doc-generation" and target "Claude Code", when the author scaffolds, then the skeleton matches the current archetype version (recorded in the draft's metadata) and passes structural lint empty-of-content.
- **R4.2 Editor with live validation:** Split-pane markdown editing, YAML frontmatter validation, inline lint (R2.7/R2.8) as-you-type, security pre-scan on save.
- **R4.3 Custom user input merge:** Author-supplied context (workflow description, examples, constraints, existing scripts) is incorporated into the scaffold without breaking archetype structure; deviations from archetype are allowed but visibly marked ("non-standard section for this category").
- **R4.4 Multi-dialect export** *(delivered)*: One canonical draft → export to selected platform dialects + zip bundle; every export embeds provenance (created-by, archetype version, validation report hash).
- **R4.5 Pre-publish gate** *(delivered)*: Full validation pipeline (7.2) runs before export/publish; failures block publish with actionable evidence, author can override only for local export (marked `unvalidated`).

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
- **R5.5 Safety refusals** *(delivered)*: The assistant refuses to help author skills whose purpose is malicious (exfiltration, agent hijacking, injection payloads) and refuses to weaken validation; refusal events are logged.

**P1**

- **R5.6 Improve-my-skill mode:** Point the assistant at an existing skill (owned or forked) → archetype-gap analysis + guided revision.
- **R5.7 Assistant-driven eval loop:** Assistant proposes test cases, interprets eval results (R2.11), and suggests targeted revisions.

### 7.6 Closing the Loop (first-class subsystem)

**P0**

- **R6.1 Publish-back** *(delivered)*: Skills created in the platform enter the same ingestion/validation pipeline as external skills — no privileged path. Their archetype-version lineage is recorded.
- **R6.2 Creation telemetry → archetype learning** *(delivered)*: Aggregate, privacy-respecting signals feed archetype refresh: which suggested sections authors keep vs. delete, which archetype elements correlate with first-pass validation success (G3), which exemplars get followed. Archetype regeneration (R3.2) consumes these signals alongside corpus statistics.
  - *AC:* Given ≥N (configurable) builder sessions in a category in a refresh window, when archetype regeneration runs, then acceptance/rejection statistics are inputs and the archetype changelog cites them.
- **R6.3 Outcome telemetry:** Where consumers opt in (or upstream registries expose it), collect post-publication signals — installs, flags, validation status over time, eval-impact scores — and attribute them to archetype versions, so "what good looks like" is grounded in outcomes, not just prevalence.
- **R6.4 Loop observability** *(delivered)*: A dashboard showing the loop working: archetype version history, what changed and why (evidence), and G3/G4 metric trends. If the loop stalls (no archetype updates despite signal volume), alert.
- **R6.5 Feedback-poisoning resistance** *(delivered)*: Telemetry is rate-limited, deduplicated per identity, and outlier-trimmed; a burst of coordinated feedback cannot move an archetype past a bounded delta per cycle. (The loop is an attack surface — treat archetype inputs like user input.)

**P1**

- **R6.6 A/B archetype evaluation:** Serve candidate vs. current archetype to a fraction of builder sessions; promote on measured first-pass-validation and author-acceptance improvement.

### 7.7 Distribution & Access — added v1.2

*Added after Phase-1 implementation review. These were assumed rather than specified, and
the gap only became visible once the corpus was real: the registry could be browsed by an
authenticated operator and by nobody else, and no skill could be obtained from it at all.
A trust-first registry that cannot hand over the artifact it vouched for is half a product,
and R2.6's integrity guarantee is untestable without a delivery path.*

**P0**

- **R8.1 Public read-only registry** *(delivered)*: Browse, search, and per-skill detail — including
  provenance, licence, verdicts, quality score and quarantine status — are reachable
  without an account. Doc 1 makes these trust surfaces un-paywallable (RC.1); this makes
  them un-gated as well. Authentication is required only to *act* (submit, build, publish).
  - *AC:* An anonymous request to a skill's detail page returns its verdicts and provenance;
    the same page for a quarantined skill returns its quarantine reasons and is excluded
    from search results.
- **R8.2 Skill export / download** *(delivered)*: A user can obtain any servable skill as a bundle. The
  bundle is bit-identical to what was validated (R2.6) and carries its provenance and
  validation-report hash. Licence posture governs what may be served: `mirror_allowed` and
  `attribution_required` serve content (the latter rendering attribution), while
  `metadata_only` and `unresolved` serve a link to origin and never the bytes.
  - *AC:* Downloading a skill twice yields identical bytes with a hash matching the verdict
    it was validated under; a `metadata_only` skill offers no download path at all.
- **R8.3 Install-path compatibility** *(delivered for the directory layout; hosted resolution endpoint still P1)*: Exported bundles are consumable by the tools people
  actually use — at minimum the `SKILL.md` directory layout, so a bundle can be dropped into
  `.claude/skills/` unchanged. A hosted resolution endpoint (`npx skills`-style) is P1.

**P1**

- **R8.4 Per-skill permalink & citation:** A stable URL per skill and per skill *version*,
  so a verdict can be cited and an archetype's exemplar list stays resolvable after the
  upstream repo moves.
- **R8.5 Corpus statistics on the landing surface** *(delivered)*: Skills indexed, sources, validation
  pass rate, licence mix, quality distribution, freshness against the R7.4 target. Doc 2
  covers operators (R1.7, R6.4) and researchers (R3.7) and specifies nothing for the ordinary
  user; this is that.
- **R8.6 Bulk / API access to metadata** for the public corpus, rate-limited and
  licence-respecting. Distinct from R3.7, which is the research dataset export.

**P2**

- **R8.7 Webhook/subscription** on corpus changes for downstream registries.

## 8. Cross-Cutting Requirements

- **R7.1 Auditability (P0):** Every state transition (indexed, quarantined, verified, archetype-updated) is an immutable event with actor, reason, and analyzer/model versions.
- **R7.2 Reproducibility (P0):** Any validation verdict and any archetype can be regenerated from stored inputs + pinned analyzer versions.
- **R7.3 Least-privilege analysis (P0):** All corpus content is untrusted input. LLM-based analyzers (R2.3, R3.x, R5.x) must treat skill text as data — analyzer prompts are hardened against injection from the skills being analyzed, and analyzer outputs are schema-validated before entering the pipeline.
- **R7.4 Performance (P1):** Full-corpus resync detects upstream changes within 24h; search p95 < 500ms at 500K skills; archetype regeneration completes within the weekly window.
- **R7.5 Compliance (P0)** *(delivered)*: DMCA/takedown workflow; license text preserved and displayed; no redistribution beyond license terms (R1.6).

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

## 10. Phasing

*(Architecture homes for each phase are assigned in Doc 3 §Proposed design and §Rollout.)*

- **Phase 1 (foundation):** Ingestion (R1.1–1.6) + Validation P0 (R2.1–2.9) + basic taxonomy (R3.1) + search/browse + **distribution (R8.1–8.3)**. *Ship a trustworthy registry first — everything else depends on a clean corpus.*
  - *(v1.2)* R8.1–8.3 moved into Phase 1: a registry nobody can read without an account and
    nothing can be downloaded from is not shippable as a registry, and R2.6's integrity
    guarantee cannot be exercised without an export path.
- **Phase 2 (intelligence):** Archetype extraction (R3.2–3.4) + Builder (R4.1–4.5).
- **Phase 3 (assistant + loop):** Assistant (R5.1–5.5) + closing the loop (R6.1–6.5).
- **Phase 4 (hardening & scale):** Sandbox behavioral testing (R2.10), eval harness (R2.11), composition analysis (R2.13), A/B archetypes (R6.6), verified tier.

Dependency note: R3.2 needs ≥50 validated skills/category → Phase 1 corpus volume gates Phase 2 quality. R6.x needs builder telemetry → Phase 3 by definition.

*(v1.2)* Corpus volume is a **source-count** problem, not a skill-count one, and the
discovery channels are not interchangeable. GitHub code search reports ~382k SKILL.md files
and caps every query at 1,000 results; sharding by file size saturates — 38 shards over the
cap with no further split available on that axis — so channel R1.1(c) cannot complete and
has no notion of value, since byte ranges are arbitrary with respect to quality. The
curated channels are what produce a quality-biased corpus: a 130k-star MIT repository with
59 skills was reached by neither the crawl nor any of the four major awesome-lists, and only
the hand-picked seed list found it. Sequence discovery as seed list → curated lists →
crawl, not the reverse.

## 10b. Implementation status — audited 2026-08-31

Read against the running system, not against intent. Corpus at the time of audit: **9,561
indexed** (canonical) · 132 quarantined · 1,153 near-duplicate variants · **249 of 606
sources synced** · 4,100 skills labelled · 10,888 structural fingerprints · 12 archetype
categories at v5.

Legend: **done** · **partial** (works, with a named gap) · **absent**.

### 7.1 Ingestion

| | | |
|---|---|---|
| R1.1 Source connectors | P0 | **partial** — GitHub repos, awesome-lists and the sharded code-search crawl all work. **No ClawHub connector**, and registry reconciliation (channel 4) is unbuilt. The crawl also cannot complete: 38 shards are saturated and unsplittable on the size axis. |
| R1.2 Normalization | P0 | **done** — five dialects into one schema with a `dialect` field. |
| R1.3 Provenance | P0 | **done** — source, path, commit, per-file hashes, licence evidence, first/last seen, upstream stars as a time series. |
| R1.4 Deduplication | P0 | **done** — content-hash uniqueness, MinHash near-duplicate clustering verified by exact Jaccard, and a description gate so template siblings are not merged. Forks are skipped at discovery with `skipReason: "fork"`. |
| R1.5 Revocation & drift | P0 | **done** — `pnpm verify:revocation`. |
| R1.6 License gating | P0 | **done** — six-step chain, postures, metadata-only never mirrored and never an exemplar. |
| R1.7 Sync scheduling | P1 | **done** — cron, freshness queue, per-source health, and the cadence itself is now operator-configurable data (Settings → Schedule) rather than a redeploy. |
| R1.8 Community submission | P1 | **partial** — admin-only submission (form + `pnpm submit`). No public endpoint. |
| R1.9 Private/tenant sources | P2 | **absent** — `sources.org_id` exists so the scope can be added without migration pain, which is what R1.9 actually asks for at this stage. |

### 7.2 Validation

| | | |
|---|---|---|
| R2.1 Static analysis | P0 | **partial** — secret-scan and capability-surface are rule-based and working. No second engine; "Semgrep-class" coverage is one engine short. |
| R2.2 Prompt-injection scan | P0 | **done** |
| R2.3 Description–behavior consistency | P0 | **done** — opt-in, costed, skipped for bundles with no code. |
| R2.4 Capability surface | P0 | **done** |
| R2.5 Quarantine workflow | P0 | **partial** — fail-closed with machine-readable reasons, curator queue, re-validation on change. **Community flagging is absent.** |
| R2.6 Integrity | P0 | **done** — `pnpm verify:export`, byte-identical downloads. |
| R2.7 Structural lint | P0 | **done** — dialect-aware. |
| R2.8 Trigger-quality heuristic | P0 | **partial** — vague-language detection lands. **Collision risk against existing skills in the same category is absent.** |
| R2.9 Quality score | P0 | **partial** — composite score is public per skill and popularity never outranks it. The ranking function has no **relevance** term because search has no relevance ranking (see R7.4). |
| R2.10 Sandbox smoke-test | P1 | **absent** |
| R2.11 Eval harness | P1 | **absent** |
| R2.12 Re-scan campaigns | P1 | **done** — `pnpm rescan`, selector is analyzer-version based. |
| R2.13 Composition analysis | P2 | **absent** |
| R2.14 Signed publication | P2 | **absent** |

### 7.3 Corpus analytics

| | | |
|---|---|---|
| R3.1 Taxonomy | P0 | **done** — two curated axes, multi-label with calibrated confidence, review floor, curator queue. LLM classification rather than embeddings; the requirement is satisfied, the mechanism differs. |
| R3.2 Archetype extraction | P0 | **done** — 12 of 13 categories at v5, banded on source trust, evidence counted in distinct structures. |
| R3.3 Exemplar selection | P0 | **done** — licence-clean, resolved live. |
| R3.4 Attribution surfacing | P0 | **done** — public archetype pages credit contributing sources. |
| R3.5 Trend analytics | P1 | **partial** — archetype version history and changelogs are on each archetype page. Category growth and emerging-cluster detection are absent (the latter needs embeddings). |
| R3.6 Similarity insight for authors | P1 | **absent** |
| R3.7 Research API / dataset export | P2 | **absent** |

### 7.4 Skill builder

| | | |
|---|---|---|
| R4.1 Archetype-driven scaffolding | P0 | **done** — category → purpose → context → archetype sections, each carrying its evidence. |
| R4.2 Editor with live validation | P0 | **absent** — the generated draft is read-only. Validation runs after generation, not as-you-type. |
| R4.3 Custom input merge | P0 | **partial** — author context is merged and grounded. Deviations from the archetype are **not visibly marked**. |
| R4.4 Multi-dialect export | P0 | **done** — one archive, a directory per requested format (SKILL.md / AGENTS.md / Cursor rule), with a receipt carrying the archetype version and validation report hash. Byte-identical across exports. |
| R4.5 Pre-publish gate | P0 | **done** — a blocking finding refuses publication; export is still allowed, which is what the requirement's local-export carve-out asks for. |
| R4.6 Template wizard | P1 | **done** — the builder is form-driven by construction. |
| R4.7 Version history & diff | P1 | **absent** |
| R4.8 Eval authoring support | P1 | **absent** |

### 7.5 Creation assistant

| | | |
|---|---|---|
| R5.1 Interview-driven drafting | P0 | **partial** — the elicitation is a stepped form, not a conversation, and drafting is one call rather than section-by-section. |
| R5.2 Corpus-grounded suggestions | P0 | **done** — every section shows prevalence in both bands, and the same evidence is passed to the model. Meets the traceability AC. |
| R5.3 Gap detection & topic suggestion | P0 | **absent** |
| R5.4 Feedback incorporation | P0 | **absent** — no accept/reject per suggestion, so no structured feedback events. |
| R5.5 Safety refusals | P0 | **done** — refusal is a field in the structured output, logged to `events`, verified against a real malicious brief. |
| R5.6 Improve-my-skill mode | P1 | **absent** |
| R5.7 Assistant-driven eval loop | P1 | **absent** |

### 7.6 Closing the loop — **the largest gap in the product**

| | | |
|---|---|---|
| R6.1 Publish-back | P0 | **done** — a draft becomes an org-scoped skill through the same rows and the same `validatePending` call an externally synced skill goes through. Archetype lineage recorded on the version. |
| R6.2 Creation telemetry → archetype learning | P0 | **done** — one signal per (draft, section) at publish: offered, authored, survived, first-pass valid. `mineArchetype` decides inclusion on `lift + delta` and the changelog cites the statistics, as the AC requires. |
| R6.3 Outcome telemetry | P0 | **absent** |
| R6.4 Loop observability | P0 | **done** — Settings → Loop: G3 and G4 with their sample size, archetype versions with the changelog that explains each, unconsumed-signal counts per category, and a stall alert when signal accumulates without a re-mine. |
| R6.5 Feedback-poisoning resistance | P0 | **done** — four defences, each against a different attack: dedup by unique index, per-org rate limit applied in SQL before counting, per-org outlier trimming, and a ±5-point bound on the delta. A distinct-organisation floor sits under all four and doubles as the privacy control. |
| R6.6 A/B archetype evaluation | P1 | **absent** |

§6 calls the loop a first-class requirement and §2 says *the loop is the product*. **The loop
now runs**: a skill created here is published back through the same pipeline as an external
one (R6.1), what happened during authoring is recorded (R6.2), and archetype regeneration
reads it alongside corpus prevalence with R6.5's bounds enforced.

What remains is **outcome** telemetry (R6.3) — nothing after publication is attributed to an
archetype version, so "what good looks like" is grounded in what the corpus contains and what
authors kept, but not yet in how the results performed.

The loop has also now been **run end to end on a real skill**, not only against fixtures:
scaffolded from archetype v5, generated, validated, published through the shared pipeline,
and five telemetry signals recorded. `pnpm walk:loop` repeats it.

### 7.7 Distribution & access

| | | |
|---|---|---|
| R8.1 Public registry | P0 | **done** |
| R8.2 Export / download | P0 | **done** |
| R8.3 Install-path compatibility | P0 | **done** for the directory layout; the hosted resolution endpoint (P1) is absent. |
| R8.4 Permalink & citation | P1 | **partial** — stable per-skill URLs. **No per-version URL**, so a verdict cannot be cited. |
| R8.5 Corpus statistics | P1 | **done** — landing page and dashboard. |
| R8.6 Bulk / API metadata access | P1 | **absent** |
| R8.7 Webhooks | P2 | **absent** |

### 8. Cross-cutting

| | | |
|---|---|---|
| R7.1 Auditability | P0 | **done** — `events` carries actor, reason and pinned versions on every transition. |
| R7.2 Reproducibility | P0 | **done** — analyzer, extractor, miner and taxonomy versions pinned on every derived row. |
| R7.3 Least-privilege analysis | P0 | **done** — corpus text and author input are both fenced as data; all model output is schema-validated. |
| R7.4 Performance | P1 | **partial** — 24h drift detection met; archetype regeneration is seconds. **Search has no index and no relevance ranking**, so the p95-at-500K target is unmet by construction. |
| R7.5 Compliance | P0 | **done** — takedown workflow, `pnpm verify:takedown`. |

### 10a. Commercial

| | | |
|---|---|---|
| RC.1 Entitlements in the DAL | P0 | **absent** — no plans exist. Trust surfaces are un-paywalled by construction, which satisfies the *spirit* and none of the mechanism. |
| RC.2 Per-org spend caps | P0 | **done** — a per-organisation monthly cap on builder and validation, a separate global platform budget for corpus analysis, fail-closed at every model call site, with the refusal naming the cap and its reset date. Threshold crossings write an audit event. |
| RC.3 Usage metering | P1 | **partial → mostly done** — every model call writes an append-only `llm_usage` row with token counts and cost priced at call time; budget decisions write audit events. The Verdict-API half does not exist because the API does not. |
| RC.4 Billing webhooks | P1 | **absent** |
| RC.5 Private corpora never feed public archetypes | P0 | **done** — enforced by explicit `org_id IS NULL` filters in mining and reads, not only by RLS. |

## 10a. Commercial & Entitlement Requirements (bridge to Doc 1)

The tier structure, pricing, and licensing rationale are defined in Doc 1 §4–5. The platform requirements they impose:

- **RC.1 (P0):** Entitlement checks are enforced in the data-access layer (never UI-only), keyed on org plan. Free-tier trust surfaces — per-skill validation verdicts, provenance, quarantine status — are **hard-coded exempt from gating** and cannot be paywalled by configuration.
- **RC.2 (P0)** *(delivered)*: Per-org monthly LLM spend caps (assistant + validation), fail-closed with clear UX; a separate global platform budget covers corpus-analyzer spend, with alerting.
- **RC.3 (P1):** Usage metering (assistant tokens, validation runs, Verdict-API lookups) flows through the audit event log (R7.1) so billing is reconstructible and auditable.
- **RC.4 (P1):** Billing-provider webhooks drive entitlement sync; entitlement writes are idempotent and tolerate late/duplicated webhook delivery.
- **RC.5 (P0):** Org-scoped private corpora (Team tier) never feed public archetypes — not even in aggregate — unless Doc 1 open question OQ-C2 is explicitly resolved otherwise.

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

