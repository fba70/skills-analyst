import "server-only";

import type { BundleFile } from "@/server/storage";
import type { SkillDialect } from "@/server/skills/detect";

/**
 * The connector interface (Doc 3, Connector SDK).
 *
 * A connector only discovers and fetches. It never hashes, never resolves licences,
 * never touches storage or the database — the pipeline owns all of that. That split is
 * both the security boundary and the reason a community connector stays easy to review:
 * the worst a bad one can do is return junk, which validation then rejects.
 */

/** Everything needed to fetch one skill, and to prove later where it came from. */
export type SkillRef = {
  /** Stable within a source: the directory path holding the skill. */
  path: string;
  /** Which format the marker file declares — decided during detection, not re-guessed. */
  dialect: SkillDialect;
  /** Immutable pin — fetches at this ref are reproducible. */
  commitSha: string;
  /** Bundle-relative file paths discovered for this skill. */
  files: string[];
  /** Nearest licence file paths, outermost last, for the licence chain to walk. */
  licenseCandidates: string[];
};

/** What a fetch returns: the bytes, plus what the source knows about them. */
export type FetchedSkill = {
  ref: SkillRef;
  files: BundleFile[];
  /** Licence files found while walking up, nearest first. */
  licenseFiles: BundleFile[];
};

/** Upstream popularity, recorded as a time series (skill_signals). */
export type SourceSignals = {
  stars?: number;
  forks?: number;
  watchers?: number;
  openIssues?: number;
};

export type EnumerateResult = {
  refs: SkillRef[];
  /**
   * The host's own canonical spelling of the repository, e.g. `NVIDIA/skills`.
   *
   * GitHub resolves `owner/repo` case-insensitively but has exactly one correct casing, and
   * only the API knows it. Every other path into this system carries whatever a crawler,
   * a sitemap or a curator's keyboard produced — so `hubspot/agent-cli-skills` was stored
   * for `HubSpot/agent-cli-skills`, and four seeds went in mis-cased.
   *
   * That is not cosmetic where it lands: `sources.name` is what R3.4 attribution credits on
   * `/archetypes`, so a vendor is publicly mis-credited. And nothing could correct it —
   * `upsertSource` only ever inserts, and the folded lookups added for the dedup mean a
   * later correctly-cased submission finds the wrong-cased row and leaves it alone.
   *
   * Null for connectors that have no authoritative name to offer.
   */
  canonicalName: string | null;
  /** Repo-level facts that apply to every skill found in this pass. */
  signals: SourceSignals;
  /** SPDX id from the host's own licence detection, or null. Repo-level: a hint only. */
  repoLicenseSpdx: string | null;
  /** Resume bookmark for paginated or sharded sources. NULL when the pass completed. */
  cursor: unknown | null;
};

export type Connector = {
  kind: string;
  enumerate(config: SourceConfig, cursor: unknown | null): Promise<EnumerateResult>;
  fetch(config: SourceConfig, ref: SkillRef): Promise<FetchedSkill>;
};

export type SourceConfig = {
  /** Canonical upstream location, e.g. https://github.com/anthropics/skills */
  url: string;
  /** Branch, tag or commit. Defaults to the repo's default branch. */
  ref?: string;
  /** Only look under these path prefixes, e.g. ["skills/"]. Empty means everywhere. */
  includePaths?: string[];
};
