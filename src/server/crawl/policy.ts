import "server-only";

/**
 * Every decision about what gets fetched, in one place.
 *
 * These are constants today and should be rows in a settings table tomorrow — see
 * "Admin settings" in CLAUDE.md. The values below are opinions about a corpus we have
 * barely measured, and the only way to improve them is to tune against real data, which
 * means tuning without a redeploy.
 *
 * Keeping them here rather than inline at each call site is what makes that later move a
 * one-module migration instead of an archaeology exercise.
 */

export const discoveryPolicy = {
  /**
   * Paths that are markers by shape but not skills in substance.
   *
   * The crawl's largest single hit was 707 markers in one repository, all of them inside
   * `test/fixtures/` under benchmark trajectories. Ingesting those would fill the corpus
   * with fixtures and skew every archetype derived from it.
   */
  excludedPathSegments: [
    "test/fixtures",
    "tests/fixtures",
    "__fixtures__",
    "trajectories",
    "node_modules",
    ".venv",
    "site-packages",
    "vendor",
    "dist",
    "build",
    ".git",
  ],

  /**
   * Above this many markers, a repository is a dataset or a large monorepo rather than a
   * skill collection — held for review, never auto-skipped.
   *
   * Not a skip, because the assumption cuts both ways: `liferay/liferay-portal` has 286
   * markers and they are real Cursor skills. Silently dropping it would lose genuine
   * content and we would never know.
   */
  markerCountReviewThreshold: 50,

  /** Below this many stars a repository is not auto-promoted. 0 disables the floor. */
  minStars: 1,

  /** Repositories untouched for longer than this are not auto-promoted. */
  maxMonthsSincePush: 24,

  /** Archived repositories are read-only upstream; skip unless explicitly requested. */
  skipArchived: true,

  /**
   * GitHub code search already excludes forks by default — measured: the same query
   * returns 121 results normally and 2,520 with `fork:true`. This flag exists so that
   * default is a recorded decision rather than an accident of the API.
   */
  includeForks: false,
} as const;

export const ingestPolicy = {
  /**
   * Hard ceiling on files in one skill bundle.
   *
   * A backstop, not a tuning knob. Detection once mistook a repository root for a skill
   * and produced a 4,508-file "bundle", turning one sync into thousands of sequential
   * fetches. The boundary bug is fixed; this ensures the next one fails loudly and
   * quickly instead of hanging a run.
   */
  maxBundleFiles: 300,

  /**
   * Concurrent file fetches per skill.
   *
   * Lowered from 8 after a run of ten repositories lost four to 429s from
   * raw.githubusercontent.com. It sits outside the API rate limit, not outside all
   * limits — a distinction that cost four repositories to learn.
   */
  fetchConcurrency: 4,

  /** Retries for a throttled or failed raw fetch, before the skill is treated as failed. */
  rawMaxRetries: 4,
  rawBackoffBaseMs: 1_000,
} as const;

export type PromotionDecision =
  | { action: "promote"; reason: string }
  | { action: "review"; reason: string }
  | { action: "skip"; reason: string };

export type CandidateFacts = {
  hitCount: number;
  samplePaths: string[] | null;
  isFork: boolean | null;
  archived: boolean | null;
  stars: number | null;
  pushedAt: Date | null;
};

/** True when every path we have seen for a repo sits under an excluded segment. */
export function allPathsExcluded(paths: string[] | null | undefined): boolean {
  if (!paths || paths.length === 0) return false;
  return paths.every((path) => isExcludedPath(path));
}

export function isExcludedPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return discoveryPolicy.excludedPathSegments.some((segment) =>
    normalized.includes(`${segment}/`),
  );
}

/**
 * The promotion rule, as one auditable function.
 *
 * Order matters: hard exclusions first, then review holds, then the quality floors. Every
 * branch returns a reason, because a decision recorded without one cannot be revisited
 * later — and these thresholds will be revisited.
 */
export function decidePromotion(facts: CandidateFacts): PromotionDecision {
  if (facts.isFork && !discoveryPolicy.includeForks) {
    return { action: "skip", reason: "fork" };
  }

  if (allPathsExcluded(facts.samplePaths)) {
    return { action: "skip", reason: "all markers under excluded paths (fixtures, vendor)" };
  }

  if (facts.archived && discoveryPolicy.skipArchived) {
    return { action: "skip", reason: "repository is archived" };
  }

  if (facts.hitCount > discoveryPolicy.markerCountReviewThreshold) {
    return {
      action: "review",
      reason: `${facts.hitCount} markers — dataset or monorepo, needs a human look`,
    };
  }

  if (facts.stars !== null && facts.stars < discoveryPolicy.minStars) {
    return { action: "skip", reason: `below the ${discoveryPolicy.minStars}-star floor` };
  }

  if (facts.pushedAt) {
    const monthsAgo =
      (Date.now() - facts.pushedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.4);
    if (monthsAgo > discoveryPolicy.maxMonthsSincePush) {
      return {
        action: "skip",
        reason: `last pushed ${Math.round(monthsAgo)} months ago`,
      };
    }
  }

  return { action: "promote", reason: "meets discovery policy" };
}
