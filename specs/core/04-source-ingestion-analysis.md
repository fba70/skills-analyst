# Skill Foundry — Source & Ingestion Analysis (Doc 4)

**Status:** Draft v1.0 · **Date:** 2026-08-28 · **Owner:** TBD
**Companions:** `01-business-concept.md` · `02-requirements-spec.md` (R1.x) · `03-implementation-spec.md` (§pipeline)

> Scope: where skills live, how to enumerate them, how to determine their licenses, whether existing registries can be used or integrated, and a concrete Phase-0 ingestion plan that gets a meaningful corpus online before community-contributed sources exist.

---

## 1. The structural insight that simplifies everything

**GitHub is the system of origin for nearly the entire public skill ecosystem; registries are (with one partial exception) indexes over GitHub, not hosts.** The Vercel skills CLI resolves every install to a GitHub `owner/repo[/path]`; skills.sh entries map back to repos; SkillsMP explicitly builds its million-plus index by crawling public GitHub for `SKILL.md` files; LobeHub exposes a remote JSON index whose entries point at repos; consumers like the Hermes Skills Hub treat registries as search layers and delegate actual fetching to GitHub. Only ClawHub genuinely *hosts* content (publish/version), and it is itself open source (MIT) with a CLI-friendly public API.

Consequences for our design:

1. **Fetch content from origin (GitHub), use registries for discovery and signals.** This sidesteps most registry ToS questions (we never bulk-mirror someone else's database), gives us commit-SHA provenance for free (R1.3), and means our content-addressed integrity chain starts at the true source rather than a mirror that could be tampered with.
2. **Registry counts massively overlap.** SkillsMP's ~1M+, LobeHub's ~170–300K, agentskill.sh's ~110K and skills.sh's ~20–90K are largely the *same* GitHub-origin skills counted differently (per-file vs per-package vs per-fork). Expect aggressive dedup: the realistic unique public corpus is plausibly in the low hundreds of thousands of skill *directories*, of which a substantially smaller fraction is non-fork, non-abandoned, non-template.
3. **The differentiation between registries is their *signal* data** (install counts, audits, curation), not their content. That data is theirs; we integrate it via APIs/partnership or link out — we don't scrape it.

## 2. Source taxonomy

Four source classes, each with a different connector and trust posture:

| Class | Examples | What we take | How |
|---|---|---|---|
| **Origin repos** (ground truth) | anthropics/skills, vercel-labs/agent-skills & vercel-labs/skills, obra/superpowers, org/vendor skill repos (Stripe, Cloudflare, Sentry, Trail of Bits, Expo, Hugging Face, Figma…) | Full content + git provenance | GitHub API/git clone, commit-SHA pinned |
| **Curated lists** (human-filtered discovery) | VoltAgent/awesome-agent-skills (~1K+, real engineering teams), ComposioHQ/awesome-claude-skills, karanb192/awesome-claude-skills (verified badges), travisvn, GetBindu, abubakarsiddik31 collections | Repo/skill URLs + curation signal ("human-reviewed") | Markdown link parser → origin fetch |
| **Index registries** (machine discovery + popularity) | skills.sh (Vercel; leaderboard, install telemetry, security-audit status), SkillsMP (largest raw index, multilingual), LobeHub (polished, JSON index), agentskill.sh | Enumeration hints + public signals (installs, audit flags) | Public API/JSON where offered; otherwise treat as discovery aid and link out; always re-fetch content from origin |
| **Hosting registries** (content host with API) | ClawHub (OpenClaw; MIT, versioned publishing, vector search API) | Content for skills that exist *only* there + registry metadata | Official API; store registry-version provenance instead of commit SHA |

A fifth pseudo-class worth listing for later: **platform-adjacent sources** — Claude Code plugin marketplaces, Hugging Face-hosted skills, NVIDIA/OpenAI vendor catalogs, and GitLab (the skills CLI already supports GitLab URLs, so a GitLab code-search connector is a cheap follow-on).

## 3. Registry-by-registry assessment

**skills.sh (Vercel).** The de-facto package-manager layer (`npx skills`, 27+ agents, 20K+ star CLI). Entries resolve to GitHub; the leaderboard ranks by anonymized install telemetry and flags security-audit status. Integration posture: *high-value, cooperative.* The CLI is open source — reading its resolution logic gives us a battle-tested reference for GitHub→skill mapping. Install counts are Vercel's data: use their public badge/endpoints per docs, attribute, don't bulk-harvest. This is also the single most natural early partner for the Verdict API (they run "routine security audits" but explicitly disclaim guarantees — our verdicts slot exactly into that gap).

**ClawHub (OpenClaw).** The one true hosting registry; MIT-licensed platform, public CLI/API, vector search, and — after the "ClawHavoc" incident (341 malicious skills discovered in Feb 2026) — moderation hooks and stricter publication thresholds. Integration posture: *directly integrable* via API; the incident history makes it both the richest source of known-bad training fixtures for our analyzers and a registry whose operators have every incentive to consume third-party verdicts.

**SkillsMP.** The largest raw index (1M+ claimed) built by crawling GitHub for SKILL.md — i.e., it is the output of the same discovery crawl we will run ourselves. Integration posture: *don't integrate; replicate the crawl.* Mirroring their index adds nothing over crawling origin, and their index is their asset. Useful as a completeness benchmark ("what fraction of SkillsMP-visible skills do we cover?").

**LobeHub.** Polished product-grade directory (~170–300K indexed) with a remotely hosted JSON index that third parties (e.g., Hermes) already consume client-side. Integration posture: *light-touch* — the JSON index is a convenient enumeration seed if their terms permit; content still fetched from origin.

**agentskill.sh, browse.sh, explainx (10K human-reviewed), NanoSkill, vendor catalogs (NVIDIA, OpenAI, Anthropic official, Hugging Face).** Long tail: small curated or vendor sets. Treat curated ones as high-trust seed lists; vendor catalogs as origin repos with first-party trust.

**Key ToS/ethics rule across all of them (feeds Doc 2 R1.x):** discovery metadata is fair to *learn from* (URLs, existence); popularity/audit signals belong to the registry that generated them and are used only via sanctioned interfaces with attribution; content is always fetched from origin under the origin's license. This keeps us the aggregator that other registries can partner with rather than the one that strip-mined them.

## 4. Discovery mechanics (how we actually enumerate)

Ordered by precision:

1. **Seed allow-list (Phase-0 week 1):** ~30–60 hand-picked origin repos: anthropics/skills, vercel-labs/agent-skills + vercel-labs/skills, the official vendor repos named in VoltAgent's list (Anthropic, Google Labs, Vercel, Stripe, Cloudflare, Netlify, Trail of Bits, Sentry, Expo, Hugging Face, Figma), obra/superpowers, and the top community packs. Expected yield: 2–5K high-quality skills — enough to bring the first archetype categories over the ≥50-validated threshold (Doc 2 R3.2) with *quality-biased* evidence, which is exactly what we want archetypes learned from.
2. **Awesome-list expansion:** parse the 6–10 major awesome lists into candidate repos; each carries an implicit "human curated" signal we record as provenance. Lists update via normal repo sync, so new entries flow in automatically.
3. **GitHub code search crawl:** `filename:SKILL.md` (plus `path:.claude/skills`, `path:skills/`, and sibling conventions like `AGENTS.md`-adjacent layouts and `.cursor/rules` for dialect breadth). Constraints that shape the connector: code search returns max ~1,000 results per query, so the crawler must *shard* queries (by size ranges, path fragments, language, created-date windows) to sweep the full space; search rate limits are separate from and tighter than REST limits; results are eventually consistent. This is a slow-burn background workflow, not a one-shot — design it as resumable shards with a coverage ledger. Fork filtering (`fork:false` + parent-repo linkage) happens here, not post-hoc: forks are the single biggest dedup class.
4. **Registry reconciliation:** enumerate ClawHub via its API (content + versions), optionally LobeHub's JSON index as a seed, and diff against our corpus to find skills our crawl missed. skills.sh leaderboard consulted for the "top-N by installs" set to guarantee the most-used skills are ingested and validated first — the corpus users will judge us by.
5. **Webhooks over polling wherever we control the relationship:** repos we're asked to index by their owners (community submission, R1.8) install a webhook; everything else polls on schedule with ETag/conditional requests to stay inside rate budgets.

**Rate-limit reality check:** 5K REST requests/hr/token; a 100K-skill corpus refresh touching ~3 files per skill is ~300K requests ≈ 60 token-hours — fine with a small token pool and conditional requests (304s are cheap), and most cycles touch only the changed subset (2K/week per Doc 3 A1). Code-search sharding is the only genuinely slow part; budget 1–2 weeks of background crawling for first full sweep.

## 5. License determination pipeline

The empirical situation: **individual skills almost never carry their own license.** Awesome lists say it outright ("individual skills maintain their own licenses") while the skills themselves usually rely on the containing repo's LICENSE file; the SKILL.md frontmatter spec has an optional `license` field that is rarely populated. So license resolution is a fallback chain, evaluated per *skill version* and stored with its evidence (which check decided, from what file, at what SHA):

1. **Frontmatter `license:` field** in SKILL.md (SPDX identifier expected). Rare but authoritative when present — it can *narrow* (a permissive skill in an otherwise unlicensed repo) and must be validated against the SPDX list; junk values → treated as absent.
2. **Skill-directory license file** (`LICENSE`/`LICENSE.txt` inside the skill folder — the pattern Anthropic's own skills use: "Complete terms in LICENSE.txt"). Monorepos with per-directory licenses are real; check the skill path upward to the repo root, nearest file wins.
3. **Repo license via GitHub Licenses API** (backed by `licensee`): returns an SPDX ID or `NOASSERTION`/`other` for non-standard texts. This resolves the majority of cases in one cheap call already needed for repo metadata.
4. **ClearlyDefined lookup** (coordinates: `git/github/owner/repo/sha`): community-curated license conclusions, useful precisely for the `NOASSERTION` residue and for per-file discoveries.
5. **ScanCode Toolkit** run inside our pipeline as the last resort for still-unresolved repos we care about (top-installed skills): full-text license detection, SPDX expression output. Expensive; run on the prioritized slice only, results cached by content hash.
6. **Unresolved ⇒ "no license" ⇒ all-rights-reserved default ⇒ metadata-only indexing** (Doc 2 R1.6): name, description, link-out, verdict — no content mirroring, no inclusion of the *text* in archetype exemplars (statistical/structural features only, no reproduction).

Additional rules the connector must encode: **dual/complex licenses** stored as SPDX *expressions* (`MIT OR Apache-2.0`), not single IDs; **license changes across versions** are per-skill-version facts (a repo relicensing does not retroactively relicense our already-mirrored older version, but it does trigger re-evaluation of what we serve); **CC-NC/ND and "source-available" (BSL, FSL, custom)** map to metadata-only regardless of technical fetchability; **attribution-required licenses (Apache-2.0 NOTICE, CC-BY)** require the provenance card to render attribution wherever content is shown — which our provenance-first design already does, so the open OQ-C4 question in Doc 1 (mirror vs link-out for attribution-required) can likely resolve toward mirroring *with rendered attribution* for the mainstream permissive set, pending counsel.

Expected distribution (plan for it, verify in week 2): a large majority of *curated/vendor* skills under MIT/Apache-2.0; a long tail of crawl-discovered repos with **no license file at all** — plausibly a third or more of raw crawl hits — which land in metadata-only tier. That's fine: metadata-only skills still get verdicts (we can analyze what we may not redistribute), still count for corpus statistics, and their authors get a reason to add a license ("add a license to unlock full listing" is a gentle, legitimate growth loop).

## 6. Phase-0 ingestion plan (before community sources exist)

Ordered waves, each with an exit gate; expected cumulative unique-skill counts are estimates to argue with:

| Wave | Sources | Est. unique skills | Gate to next wave |
|---|---|---|---|
| **0 — Golden seed** (week 1) | anthropics/skills + vercel-labs + 10 official vendor repos | ~500–1,500 | Pipeline round-trips: ingest→validate→verdict→serve, provenance complete |
| **1 — Curated layer** (weeks 1–3) | 6–10 awesome lists expanded + explainx-class reviewed sets + top-100 skills.sh leaderboard packages | ~3–8K | Quarantine precision ≥90% on spot-check; ≥5 categories cross the 50-validated archetype threshold |
| **2 — Hosting registry** (weeks 3–5) | ClawHub full enumeration via API (incl. version history) | +15–60K | Known-bad fixture set assembled from ClawHavoc-era removals; analyzer recall measured against it |
| **3 — Open crawl** (weeks 4–10, background) | Sharded GitHub code search, fork-filtered, license-gated | +50–200K raw → far fewer listed after license/quality gates | Coverage ledger ≥70% vs. SkillsMP-visible benchmark (Doc 1 metric); infra cost within Doc 3 envelope |
| **4 — Reconciliation & tail** (ongoing) | LobeHub index diff, GitLab connector, community submissions endpoint | incremental | — |

Deliberate sequencing logic: **quality before volume.** Waves 0–1 give archetype mining a corpus biased toward skills humans already vetted, so the first archetypes encode good practice rather than the median of a million abandoned drafts; wave 3's raw crawl then serves *coverage and verdicts* (the trust product needs breadth) without being allowed to dominate archetype evidence — archetype inputs stay quality-score-weighted (Doc 2 R3.2 stats) precisely so the open crawl can't regress them.

Signals captured at ingest, per skill version, because they're cheap now and expensive to backfill: stars, fork status + parent, last-commit recency, contributor count, curated-list membership(s), registry install counts where legitimately available, audit flags, and — for ClawHub — moderation history. These seed the quality score (Doc 2 R2.9) and the "battle-tested" ranking dimension.

## 7. Open questions raised by this analysis

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ-S1 | skills.sh / Vercel: formal terms for leaderboard-signal use + early Verdict-API partnership conversation (they're simultaneously our platform vendor — leverage, and dependency) | Product | Before wave 1 ships signals |
| OQ-S2 | ClawHub API terms for full enumeration + whether ClawHavoc-era removed-skill archive is obtainable as analyzer fixtures | Eng | Before wave 2 |
| OQ-S3 | Counsel: confirm "metadata-only + link-out" posture for unlicensed repos and "mirror with rendered attribution" for Apache/CC-BY (resolves Doc 1 OQ-C4) | Legal | Before wave 3 (open crawl) |
| OQ-S4 | GitHub code-search sharding design + secondary discovery via GH Archive/BigQuery public dataset as a cheaper bulk enumerator | Eng | Spike during wave 1 |
| OQ-S5 | Whether SkillsMP/LobeHub coverage benchmarks can be computed without bulk-scraping (sampling protocol) | Eng | Wave 3 gate definition |
