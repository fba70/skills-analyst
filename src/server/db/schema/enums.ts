import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Shared vocabularies. Enums rather than free text because every one of these drives a
 * decision somewhere — what gets served, what gets mirrored, what gets re-scanned — and
 * a typo in a status column is a silent trust failure.
 */

/** How a source is discovered and fetched (Doc 2 R1.1). */
export const sourceKind = pgEnum("source_kind", [
  "github_repo",
  "github_code_search",
  "awesome_list",
  "clawhub",
  "manual_submission",
]);

export const sourceHealth = pgEnum("source_health", [
  "unknown",
  "healthy",
  "degraded",
  "failing",
  "paused",
]);

/** The format a skill was authored in. Superset schema, `dialect` records the origin. */
export const skillDialect = pgEnum("skill_dialect", [
  "anthropic_skill", // SKILL.md, the Agent Skills standard
  "claude_plugin",
  "openclaw_skill",
  "cursor_rule",
  "agents_md",
  "unknown",
]);

/**
 * Lifecycle of a skill version. Fail-closed: nothing reaches `indexed` without passing
 * validation, and a failure lands in `quarantined` with reasons, never dropped.
 */
export const skillVersionStatus = pgEnum("skill_version_status", [
  "pending", // fetched, not yet validated
  "validating",
  "indexed", // passed, servable
  "quarantined", // failed, curator-visible only
  "revalidating", // upstream changed; the previous version stays served
  "tombstoned", // withdrawn upstream; metadata retained, content withdrawn
  "withdrawn", // withdrawn on request (R7.5); blocked from re-ingestion
]);

/** Rolled up from the skill's current version, for listing and ranking. */
export const skillStatus = pgEnum("skill_status", [
  "pending",
  "indexed",
  "quarantined",
  "tombstoned",
  "withdrawn",
]);

/**
 * ## Why `withdrawn` is not `tombstoned`
 *
 * Both end with the content gone and the metadata kept, so reusing `tombstoned` is
 * tempting. They differ in the one place it matters: **what the next sync does.**
 *
 * A tombstone means "gone upstream", and it is *supposed* to reverse itself — if the file
 * comes back, the next enumeration finds it and re-indexes it. A takedown means "we were
 * told to stop", and a sync that quietly restores it is not a takedown at all. Two causes,
 * two re-ingestion rules, so two statuses; folding them together would put the difference
 * somewhere a `where` clause can forget it.
 *
 * They also read differently to a visitor. "The author deleted this" and "this was removed
 * following a request" are not the same notice, and only one of them is honest about who
 * acted.
 */

/** Why someone asked for content to come down (Doc 2 R7.5). */
export const takedownGrounds = pgEnum("takedown_grounds", [
  "copyright", // a DMCA notice or its equivalent
  "license_violation", // mirrored beyond what the upstream licence permits (R1.6)
  "privacy", // personal data inside the content
  "trademark",
  /** No legal claim: the author asked, and Doc 1 makes that obligation structural. */
  "author_request",
  "other",
]);

/**
 * A takedown's life.
 *
 * `received` is a real state, not a formality. A notice that arrives is logged before it is
 * judged, so the record of what was claimed exists even if the claim is refused — which is
 * the half of a takedown workflow that protects the platform rather than the claimant.
 *
 * `reinstated` rather than deleting the row: a retracted or successfully counter-noticed
 * takedown is itself a fact worth keeping, and the block has to be lifted by a state change
 * that leaves a trail.
 */
export const takedownStatus = pgEnum("takedown_status", [
  "received",
  "upheld",
  "rejected",
  "reinstated",
]);

/** One skill, or every skill from one repository. */
export const takedownScope = pgEnum("takedown_scope", ["skill", "source"]);

/**
 * What the licence lets us do with the content (Doc 2 R1.6).
 *
 * Analysis always happens — we fetch, analyse in memory, and keep the hash, the verdicts
 * and the metadata. This column decides only whether the *text* is mirrored into our
 * storage. `metadata_only` and `unresolved` mean: never mirrored, never quoted as an
 * archetype exemplar.
 */
export const redistributionPosture = pgEnum("redistribution_posture", [
  "mirror_allowed", // permissive, no attribution string required
  "attribution_required", // mirror, but render attribution wherever shown
  "metadata_only", // non-redistributable: name, description, link out
  "unresolved", // licence unknown — treated as metadata_only until resolved
]);

/** Which step of the six-step chain (Doc 4 §5) produced the licence answer. */
export const licenseSource = pgEnum("license_source", [
  "frontmatter",
  "in_tree_license",
  "github_api",
  "clearlydefined",
  "scancode",
  "unresolved",
]);

/** Upstream popularity and usage signals, kept as a time series. */
export const signalKind = pgEnum("signal_kind", [
  "stars",
  "forks",
  "watchers",
  "downloads",
  "installs",
  "open_issues",
  "registry_rank",
]);

export const verdictResult = pgEnum("verdict_result", [
  "pass",
  "warn",
  "fail",
  "error", // the analyzer itself failed; never counts as a pass
]);

export const verdictSeverity = pgEnum("verdict_severity", [
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

/** Who caused an audited event. */
export const actorType = pgEnum("actor_type", [
  "user",
  "system", // scheduled or pipeline work
  "analyzer",
  "api_key",
]);

/**
 * A shard's place in the crawl.
 *
 * `saturated` is the one that matters: GitHub reported more than the 1,000-result cap, so
 * the shard cannot be read to the end and has been split into children. Recording it
 * distinctly from `complete` is what stops a partially-read search space from looking
 * fully covered.
 */
export const crawlShardStatus = pgEnum("crawl_shard_status", [
  "pending",
  "running",
  "complete",
  "saturated",
  "failed",
]);

/** What we decided about a repository the crawl turned up. */
export const discoveredRepoStatus = pgEnum("discovered_repo_status", [
  "new",
  /** Metadata fetched, awaiting a promotion decision. */
  "enriched",
  "promoted",
  /** Held for a human: probably a dataset or monorepo, but may hold real skills. */
  "needs_review",
  "skipped",
]);

/**
 * Which axis a category assignment sits on (Doc 2 R3.1).
 *
 * `domain` is the field served, `function` is what the skill does. Structure correlates
 * with function, so archetypes are mined per function; domain drives browse and filter.
 * Keeping them apart in the type means a query can never accidentally average a rubric
 * together with a template.
 */
export const categoryAxis = pgEnum("category_axis", ["domain", "function"]);

/** Who decided a category. A curator's answer outranks a classifier's and is never re-run. */
export const categoryAssignedBy = pgEnum("category_assigned_by", [
  "classifier",
  "curator",
  /** Derived from a deterministic rule rather than a model — cheap and explainable. */
  "heuristic",
]);
