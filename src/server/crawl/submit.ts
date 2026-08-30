import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { repoFromUrl } from "@/server/connectors/awesome-list";
import { githubConnector, parseRepoUrl } from "@/server/connectors/github";
import { db } from "@/server/db";
import { discoveredRepos, events, sources } from "@/server/db/schema";

import { discoveryPolicy, isExcludedPath } from "./policy";

/**
 * Submitting a repository by hand (Doc 2 R1.8).
 *
 * ## One pipeline, not two
 *
 * The single design decision here: a submitted repository does **not** get its own fetch
 * path. It becomes a `discovered_repos` row and rides the same
 * enrich → decide → promote → sync → validate route the crawl uses. A second path would
 * mean two places where licence gating, fork filtering and quarantine rules have to agree,
 * and they would drift — the shortcut that skips validation is always the one someone adds
 * to a hand-submission path "just for now".
 *
 * What submission actually changes is *who decides*, not *what happens*. An admin
 * submission is a promotion decision made by a person instead of by `policy.ts`, so it
 * lands as `promoted` with a source row attached. A future user submission (R1.8's public
 * half) sets `needs_review` and lands in the queue the curator panel already renders.
 *
 * ## Preflight before promising anything
 *
 * The repository is enumerated before it is accepted. That costs two API calls and answers
 * the only question that matters — does this repository contain skills at all — before a
 * source row exists. Promoting an empty repository is worse than refusing it: it creates a
 * source that syncs nothing, reports healthy, and quietly pads the source count.
 */

export type SubmitOutcome =
  | {
      ok: true;
      status: "promoted" | "needs_review";
      owner: string;
      repo: string;
      url: string;
      /** Skill markers the preflight actually found. */
      skillsFound: number;
      samplePaths: string[];
      stars: number | null;
      licenseSpdx: string | null;
      sourceId: string | null;
      /** Set when the repository was already known — nothing was duplicated. */
      alreadyKnown: "source" | "discovered" | null;
    }
  | { ok: false; reason: string };

const API = "https://api.github.com";

type RepoMeta = {
  full_name: string;
  stargazers_count: number;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  pushed_at: string | null;
  parent?: { full_name: string };
  license: { spdx_id: string | null } | null;
};

function headers(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "skill-foundry",
  };
}

/**
 * Accepts what a person actually pastes.
 *
 * `parseRepoUrl` in the connector wants a real github.com URL; a curator pasting
 * `anthropics/skills` is not making a mistake worth an error message. Normalising here
 * rather than loosening the connector keeps the strict parser strict for machine input.
 */
export function normalizeRepoInput(input: string): { owner: string; repo: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("Enter a repository URL or owner/name.");

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.replace(/\.git$/, "").split("/");
    return { owner, repo };
  }

  // Reuse the list parser's judgement for full URLs: it already knows that
  // `github.com/sponsors/x` and `/owner/repo/tree/main/...` are not what they look like,
  // and two copies of that rule would drift.
  const viaList = repoFromUrl(trimmed);
  if (viaList) return viaList;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return parseRepoUrl(withScheme);
}

export type SubmitOptions = {
  /** Who asked. Recorded on the row so a later policy change is reviewable. */
  submittedBy: string;
  /**
   * Admin submissions promote straight away; anything else queues for review. The public
   * half of R1.8 will pass `false` here and reuse everything below unchanged.
   */
  autoPromote: boolean;
  /**
   * Narrow a monorepo to these prefixes, e.g. `["workspaces/"]`.
   *
   * This is the cheap half of the giant-repository problem: the recursive tree call
   * truncates above ~100k entries and the connector refuses to proceed on a truncated
   * tree, so a monorepo like `liferay/liferay-portal` cannot be synced whole. Letting the
   * person who is already looking at the repository say where the skills live avoids
   * building a tarball reader to answer the same question.
   */
  includePaths?: string[];
};

export async function submitRepository(
  input: string,
  options: SubmitOptions,
): Promise<SubmitOutcome> {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = normalizeRepoInput(input));
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const url = `https://github.com/${owner}/${repo}`;

  // Already a source? Say so plainly. Re-submitting a known repository is a normal thing
  // to do — the honest answer is "we have it", not a duplicate row.
  const [existingSource] = await db
    .select({ id: sources.id, name: sources.name })
    .from(sources)
    .where(and(eq(sources.url, url), isNull(sources.orgId)))
    .limit(1);

  const [existingRepo] = await db
    .select({ id: discoveredRepos.id, status: discoveredRepos.status })
    .from(discoveredRepos)
    .where(
      and(
        eq(discoveredRepos.host, "github.com"),
        eq(discoveredRepos.owner, owner),
        eq(discoveredRepos.repo, repo),
      ),
    )
    .limit(1);

  // ---- Preflight: does it exist, and does it hold skills? ------------------
  let meta: RepoMeta;
  try {
    const response = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers() });
    if (response.status === 404) {
      return { ok: false, reason: `${owner}/${repo} does not exist or is private.` };
    }
    if (response.status === 451) {
      return { ok: false, reason: `${owner}/${repo} is unavailable for legal reasons.` };
    }
    if (!response.ok) {
      return { ok: false, reason: `GitHub returned ${response.status} for ${owner}/${repo}.` };
    }
    meta = (await response.json()) as RepoMeta;
  } catch (error) {
    return { ok: false, reason: `Could not reach GitHub: ${(error as Error).message}` };
  }

  let refs: Awaited<ReturnType<typeof githubConnector.enumerate>>["refs"] = [];
  let repoLicenseSpdx: string | null = meta.license?.spdx_id ?? null;
  try {
    const enumerated = await githubConnector.enumerate(
      { url, includePaths: options.includePaths },
      null,
    );
    refs = enumerated.refs;
    repoLicenseSpdx = enumerated.repoLicenseSpdx ?? repoLicenseSpdx;
  } catch (error) {
    // A truncated tree lands here. The message names the includePaths escape hatch
    // because that is the actual fix, and the curator is the person who can apply it.
    return {
      ok: false,
      reason:
        `Could not list ${owner}/${repo}: ${(error as Error).message}` +
        (options.includePaths?.length
          ? ""
          : " — if this is a monorepo, narrow it with include paths."),
    };
  }

  const usable = refs.filter((ref) => !isExcludedPath(ref.path));
  if (usable.length === 0) {
    return {
      ok: false,
      reason:
        refs.length > 0
          ? `Found ${refs.length} marker file(s) in ${owner}/${repo}, but all of them sit under excluded paths (tests, fixtures, node_modules).`
          : `No SKILL.md or AGENTS.md found in ${owner}/${repo}.`,
    };
  }

  const samplePaths = usable.slice(0, 10).map((ref) => ref.path || "(repository root)");
  const status = options.autoPromote ? ("promoted" as const) : ("needs_review" as const);

  // ---- Write ---------------------------------------------------------------
  let sourceId: string | null = existingSource?.id ?? null;

  /**
   * An admin naming a repository *is* the review the marker threshold asks for.
   *
   * Without this the two gates disagree: submission promotes the repo, then `syncSource`
   * refuses it for holding more than `markerCountReviewThreshold` markers and disables the
   * source — which is what happened to `aws/agent-toolkit-for-aws` at 155 skills. The
   * threshold exists to stop the *crawl* silently ingesting a monorepo nobody looked at,
   * and someone typing the name into the admin form is precisely the "someone looked at
   * it" the rule wants. A held submission does not get it: that one has not been reviewed
   * yet, by definition.
   */
  const reviewedLargeRepo =
    options.autoPromote && usable.length > discoveryPolicy.markerCountReviewThreshold;

  await db.transaction(async (tx) => {
    if (sourceId && (options.includePaths?.length || reviewedLargeRepo)) {
      // The repository was already a source — from the crawl, or an earlier submission —
      // so no row is inserted below and the new include paths would be dropped on the
      // floor. That failure is silent and expensive: the source keeps the whole-repo
      // config, the tree call keeps truncating, and the sync keeps failing for a reason
      // the curator already fixed. Merge them onto the existing config instead.
      await tx
        .update(sources)
        .set({
          // Re-submitting is an explicit "sync this". A source that a previous run paused
          // — for holding more markers than the threshold, say — must come back enabled,
          // or the admin's decision is recorded and then ignored.
          enabled: true,
          config: sql`${sources.config} || ${JSON.stringify({
            ...(options.includePaths?.length
              ? { includePaths: options.includePaths, narrowedBy: options.submittedBy }
              : {}),
            ...(reviewedLargeRepo
              ? { allowLargeRepo: true, approvedBy: options.submittedBy }
              : {}),
          })}::jsonb`,
        })
        .where(eq(sources.id, sourceId));
    }

    if (options.autoPromote && !sourceId) {
      const [created] = await tx
        .insert(sources)
        .values({
          kind: "manual_submission",
          name: `${owner}/${repo}`,
          url,
          config: {
            discoveredBy: "manual-submission",
            submittedBy: options.submittedBy,
            ...(reviewedLargeRepo ? { allowLargeRepo: true } : {}),
            ...(options.includePaths?.length
              ? { includePaths: options.includePaths }
              : {}),
          },
          health: "unknown",
        })
        .returning({ id: sources.id });
      sourceId = created.id;
    }

    const values = {
      host: "github.com",
      owner,
      repo,
      url,
      isFork: meta.fork,
      parentRepo: meta.parent?.full_name ?? null,
      stars: meta.stargazers_count,
      archived: meta.archived,
      defaultBranch: meta.default_branch,
      pushedAt: meta.pushed_at ? new Date(meta.pushed_at) : null,
      enrichedAt: new Date(),
      hitCount: usable.length,
      samplePaths,
      status,
      // A submission overrides an earlier skip: a person looked at it and disagreed with
      // the policy, and that disagreement is the whole point of a manual path.
      skipReason: null,
      submittedBy: options.submittedBy,
      sourceId,
      lastSeenAt: new Date(),
    };

    await tx
      .insert(discoveredRepos)
      .values(values)
      .onConflictDoUpdate({
        target: [discoveredRepos.host, discoveredRepos.owner, discoveredRepos.repo],
        set: values,
      });

    await tx.insert(events).values({
      actorType: "user",
      actorId: options.submittedBy,
      kind: "repo.submitted",
      subjectType: "discovered_repos",
      subjectId: existingRepo?.id ?? null,
      reason: options.autoPromote ? "admin submission" : "queued for review",
      payload: {
        url,
        skillsFound: usable.length,
        samplePaths,
        includePaths: options.includePaths ?? [],
        sourceId,
        alreadyKnown: existingSource ? "source" : existingRepo ? "discovered" : null,
      },
    });
  });

  return {
    ok: true,
    status,
    owner,
    repo,
    url,
    skillsFound: usable.length,
    samplePaths,
    stars: meta.stargazers_count,
    licenseSpdx: repoLicenseSpdx,
    sourceId,
    alreadyKnown: existingSource ? "source" : existingRepo ? "discovered" : null,
  };
}
