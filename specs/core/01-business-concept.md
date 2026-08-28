# Skill Foundry — Business Concept (Doc 1 of 3)

**Status:** Draft v1.0 · **Date:** 2026-08-27 · **Owner:** TBD
**Companion documents:** `02-requirements-spec.md` (what we build) · `03-implementation-spec.md` (how we build it) · `04-source-ingestion-analysis.md` (where the corpus comes from)
**Changelog:** v1.1 — market evidence and partner posture updated from the source analysis (Doc 4)

---

## 1. The Idea

Agent skills — packaged, reusable instruction bundles (SKILL.md + scripts + references) that extend AI coding agents — have reached marketplace scale: public registries index tens to hundreds of thousands of them. But the ecosystem is split into two halves that don't talk to each other. **Registries** collect and categorize skills; **skill creators/wizards** generate new ones. No system mines the corpus to learn what good skills in each category actually look like and feeds that structure back into creation. And the corpus itself is contaminated: a 2026 audit of 22,511 public skills found 140,963 issues (~6.3 per skill), separate research found prompt injection in roughly a third of skills tested, and one major registry discovered 341 outright malicious skills in its own catalog — while the major free registries still run no automated security scanning at all, relying on star thresholds and the assumption that users audit before installing.

Skill Foundry closes the loop:

```
 ingest (multi-source) → validate (security + quality) → analyze (categories,
 structural archetypes) → build (archetype-driven scaffolding) → assist
 (corpus-aware guided creation) → publish + telemetry → back into the corpus
```

The product is not a registry with a builder bolted on. **The product is the loop**: every skill created through the platform improves the knowledge that guides the next author, and every validation verdict makes the shared corpus more trustworthy.

## 2. Why now

Three conditions converged in the last twelve months: (a) an open skill standard (Anthropic's Agent Skills format) achieved cross-platform adoption, making a canonical corpus feasible; (b) registries hit six-figure skill counts, giving the structural mining enough data density per category; (c) high-profile supply-chain research made skill security a recognized problem that no incumbent registry has credibly solved. The window is open for a trust-and-intelligence layer before the incumbent registries build one.

## 3. Users, Community, and Incentives

A closed-loop platform lives or dies on participation, so incentives are a design object, not a marketing afterthought. For each participant: what they give, what they get, and why the exchange is stable.

**Skill authors** give authoring effort and (aggregate, opt-in) creation telemetry. They get: a materially better authoring experience — corpus-derived skeletons, exemplar-grounded suggestions, first-pass validation ≥80% — plus distribution, attribution (provenance is first-class), a public quality/security badge on their work, and eventually a verified-publisher identity. The honest pitch: *you'll ship a better skill in a third of the time, and it will carry a trust signal you can't self-issue.*

**Skill consumers** (developers, teams installing skills) give usage signals and flags. They get the thing no registry currently offers: evidence-backed verdicts per skill — security tier, quality score, capability surface ("this skill can touch the network and your filesystem"), provenance, and license clarity — so an install decision stops being an act of faith. Ranking is trust-weighted, never popularity- or pay-weighted.

**Source & connector contributors** — the community contribution we most need, per the project's own thesis: not deep core-code changes but *more sources, more dialect parsers, more validation rules, more skill knowledge*. They give connectors and rule packs under a permissive license. They get: their ecosystem's skills represented and validated (a registry operator or framework maintainer has a direct interest in their dialect being first-class), contributor attribution on category pages and archetypes, and — because connectors are Apache-licensed — the freedom to reuse their own contribution anywhere, including competing projects. That last point is deliberate: it makes contributing feel safe rather than extractive.

**Upstream skill authors we ingest** (who never signed up): the platform's obligations to them are structural — 100% provenance and attribution, license gating (metadata-only indexing where redistribution isn't permitted), takedown workflow, and quarantine with machine-readable reasons plus an appeal path rather than silent judgment. An aggregator that treats upstream authors as free raw material burns the commons it depends on.

**Researchers** get license-clean corpus statistics and archetype snapshots (CC BY-SA), and give back citations, analyses, and — historically the source of the best security findings — audits.

One small structural growth loop worth naming: unlicensed skills are indexed metadata-only (Doc 4 §5), so "add a license to unlock full listing" gives upstream authors a legitimate, self-serve reason to engage — the platform's license gating doubles as its gentlest acquisition channel.

**The flywheel, stated plainly:** more sources → richer corpus → better archetypes → better authoring → more (and better) skills published through the platform → more telemetry and more corpus → repeat. Validation runs across the whole loop and is what makes the corpus worth mining and the output worth trusting. Every incentive above feeds at least one arrow of this loop; anything that doesn't is out of scope.

## 4. Open Source Strategy & Licensing

### 4.1 The strategic frame

The defensible asset is **not the code — it is the data flywheel**: the continuously synced validated corpus, the accumulated analyzer-versioned verdicts, and the archetypes refined by authoring telemetry. Code can be reimplemented in months; a year of verdicts and telemetry cannot. Licensing therefore maximizes community contribution where it feeds the flywheel, and commercializes the *operated* flywheel.

So: **not a pure open source project, and not closed SaaS — open core with an operational (not functional) split.** The self-hosted version is complete, not crippled; what the hosted version sells is the expensive-to-run part: continuous sync, LLM analyzer fleets, re-scan campaigns, the live full-corpus archetypes, and private tenancy.

### 4.2 License structure (two-layer open core)

| Component | License | Rationale |
|---|---|---|
| Canonical skill schema, dialect mappings, provenance format | **Apache-2.0** | The standard layer — adoption is the goal; zero friction, patent grant, safe for every vendor to implement. |
| Source-connector SDK, all connectors, dialect parsers, validation rule packs | **Apache-2.0** | The community contribution surface. Apache-licensed connectors can be reused anywhere — including by competing registries — and that's fine: more parseable sources grow the commons the platform mines. |
| Platform (pipeline, validation orchestrator, analytics, builder, assistant, web app) | **AGPL-3.0** | Complete and self-hostable. AGPL deters a hyperscaler from operating a hosted clone without contributing back, while remaining a genuine OSI license. **Deliberately not BSL/FSL:** a trust-positioned security project cannot afford "source-available" optics with the contributor community it depends on. |
| Archetypes + corpus statistics (derived data) | **CC BY-SA 4.0** snapshots; commercial terms for the live API | Community and researchers get real value; commercial embedding of the *live, continuously refreshed* feed is the paid product. |
| Validation verdicts | Public per skill, free, always; **bulk/API access commercial** | The per-skill verdict is the trust signal — paywalling it would destroy the platform's reason to exist. |

**Contributor terms: DCO, no CLA with relicensing rights.** A relicensing CLA contradicts the AGPL trust story and suppresses exactly the connector contributions we need. Accepted consequence, stated out loud: the AGPL core can never be relicensed proprietary without contributor consent — the hosted moat must stand on operations and data, not on a future relicense option.

Ingested third-party skill content is governed by *its own* upstream licenses (gated at ingestion); the licenses above cover platform code and platform-derived data only.

### 4.3 OSS vs. hosted split

| Capability | Self-hosted (AGPL) | Hosted |
|---|---|---|
| Full pipeline, builder, assistant | ✅ (bring your own LLM keys, sync tokens, sandbox infra) | ✅ operated, SLA-backed |
| Public corpus | Sync it yourself from sources | Pre-built, continuously refreshed, verdict-backed |
| Archetypes | Compute from your own corpus (needs volume) | Live archetypes from the full corpus + telemetry |
| Analyzer updates, re-scan campaigns | Your ops burden | Included |
| Private tenant corpora, SSO/SCIM, audit exports | Build/operate yourself | Paid tiers |

## 5. Monetization (hosted)

**Free — the flywheel tier.** Public browsing/search, per-skill verdicts, public authoring via builder + assistant (fair-use LLM quota), community submission. Purpose: corpus volume, telemetry volume, distribution. This tier's trust surfaces are never degraded — see RC.1 in Doc 2.

**Pro (per-seat, ~$15–25/seat/mo).** Private skills and drafts, team workspaces, higher assistant/validation quotas, eval-harness runs, version history, priority validation queue.

**Team / Enterprise (per-org, ~$500–2,000+/mo).** **Private tenant corpus** — internal sources (private GitHub/GitLab) run through the same pipeline; org-scoped archetypes blending public + private evidence; org-wide install-policy gates ("nothing below verified tier"); SSO/SCIM; compliance/audit exports; support SLA. Self-host support contracts land here.

**Verdict & Archetype API (B2B, usage-priced) — the sleeper product.** Other registries, IDE vendors, and agent platforms embed live verdicts, capability-surface metadata, and risk scores by content hash. This monetizes the flywheel *without* competing on distribution — potential rivals become customers. Target: 2 design partners within two quarters of API GA.

**Metered add-ons.** Sandbox behavioral testing beyond quota; bulk re-validation of private corpora; assistant tokens beyond plan.

**Explicitly not monetized:** no rev-share marketplace, no paid ranking, no paywalled security information on public skills. These are load-bearing trust commitments, not deferred features.

### 5.1 Commercial success metrics

- Free→Pro conversion ≥3% of weekly-active authors at 6 months.
- ≥2 Verdict-API design partners within 2 quarters of API GA.
- Hosted gross margin on LLM-heavy tiers ≥70% (this target drives quota design, RC.2 in Doc 2).
- Contribution health: ≥10 community-contributed connectors/dialect parsers in year 1 (leading indicator that the incentive design works).

## 6. Competitive posture

Incumbent registries compete on volume and distribution; skill creators compete on authoring UX. Skill Foundry's position is the layer neither has: **trust (validation) + intelligence (archetypes) + the loop connecting them.** If an incumbent adds scanning, they still lack the creation loop and telemetry; if a creator tool adds templates, they lack corpus grounding. The two-sided defensibility is the accumulated verdict/telemetry data — which is also why the Verdict API strategy converts the most dangerous competitors (registries) into channel customers. Two concrete relationships shape this (analysis in Doc 4 §3): **Vercel** is simultaneously our infrastructure vendor, the ecosystem's de-facto package manager (skills CLI + skills.sh leaderboard), and the most natural first Verdict-API partner — its directory runs audits but explicitly disclaims guarantees, which is precisely our gap to fill; that triple role is leverage and dependency at once and gets managed deliberately, not discovered. **ClawHub/OpenClaw** — the one registry that actually hosts content, open source, and publicly burned by a malicious-skill incident — is the second design-partner candidate, with every incentive to consume third-party verdicts.

## 7. Open questions (commercial)

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ-C1 | AGPL + hosted boundary: confirm repo separation so hosted-only services (billing, quota) stay proprietary without AGPL contamination | Legal | Yes — before first external contribution |
| OQ-C2 | May org-private archetypes ever feed public ones, even aggregated? (Default: never — one leak of a customer's internal workflow shape is existential for the enterprise tier) | Product | No, default holds |
| OQ-C3 | Verified-publisher program pricing (badge + signing): revenue vs. trust-dilution tradeoff | Product | No |
| OQ-C4 | Redistribution posture for attribution-required licenses: full mirror vs. metadata + link-out (elaborated as Doc 4 OQ-S3; likely resolution: mirror with rendered attribution for mainstream permissive licenses) | Legal | Yes — affects storage design |
| OQ-C5 | Vercel relationship strategy: formal terms for leaderboard-signal use + Verdict-API partnership sequencing, given the vendor/channel/partner triple role (Doc 4 OQ-S1) | Product | Before signals ship |
