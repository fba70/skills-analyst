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
]);

/** Rolled up from the skill's current version, for listing and ranking. */
export const skillStatus = pgEnum("skill_status", [
  "pending",
  "indexed",
  "quarantined",
  "tombstoned",
]);

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
