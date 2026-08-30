import "server-only";

import { and, eq } from "drizzle-orm";

import { fetchList } from "@/server/connectors/awesome-list";
import { db } from "@/server/db";
import { discoveredRepos, events, sources } from "@/server/db/schema";

import { submitRepository, type SubmitOutcome } from "./submit";
import { SEED_LISTS, SEED_REPOS, type SeedList, type SeedRepo } from "./seeds";

/**
 * Applying the seed allow-list and expanding curated lists (Doc 4 §4 steps 1–2).
 *
 * Both paths end in the same place as everything else: a `discovered_repos` row that rides
 * enrich → decide → sync → validate. Seeds and lists change *what gets found and in what
 * order*, never what happens to it afterwards. That is the whole reason this is safe to run
 * broadly — nothing here can put an unvalidated skill in front of a user.
 *
 * The two differ in trust, and the difference is recorded rather than assumed:
 *
 *   - a **seed repo** was picked by us, so it promotes directly;
 *   - a **list entry** was picked by someone else, so it enters as an ordinary candidate
 *     and the promotion policy judges it. The curation is kept as provenance
 *     (`listRank`, `section`, which list), because it is real evidence — it is simply not
 *     the same as our own decision.
 */

export type SeedReport = {
  attempted: number;
  added: number;
  alreadyKnown: number;
  failed: number;
  skillsFound: number;
  results: Array<{ repo: string; ok: boolean; detail: string }>;
};

/**
 * Runs the seed allow-list.
 *
 * Sequential: this is a few dozen repositories, each costing two API calls plus a tree
 * read, and a burst of parallel tree calls against the same token is how you spend a rate
 * limit on something that has no deadline.
 */
export async function applySeedRepos(
  options: { submittedBy: string; only?: string[]; onProgress?: (m: string) => void } = {
    submittedBy: "system.seed",
  },
): Promise<SeedReport> {
  const log = options.onProgress ?? (() => {});
  const targets: readonly SeedRepo[] = options.only?.length
    ? SEED_REPOS.filter((seed) => options.only!.includes(seed.repo))
    : SEED_REPOS;

  const report: SeedReport = {
    attempted: targets.length,
    added: 0,
    alreadyKnown: 0,
    failed: 0,
    skillsFound: 0,
    results: [],
  };

  for (const seed of targets) {
    log(`seeding ${seed.repo}`);
    let outcome: SubmitOutcome;
    try {
      outcome = await submitRepository(seed.repo, {
        submittedBy: options.submittedBy,
        // A held seed enters the review queue exactly like a user submission would. Same
        // path, different decision — which is the whole point of keeping one pipeline.
        autoPromote: !seed.holdForReview,
        includePaths: seed.includePaths ? [...seed.includePaths] : undefined,
      });
    } catch (error) {
      report.failed += 1;
      report.results.push({ repo: seed.repo, ok: false, detail: (error as Error).message });
      continue;
    }

    if (!outcome.ok) {
      report.failed += 1;
      report.results.push({ repo: seed.repo, ok: false, detail: outcome.reason });
      continue;
    }

    report.skillsFound += outcome.skillsFound;
    if (outcome.alreadyKnown) report.alreadyKnown += 1;
    else report.added += 1;

    // The verified count is documentation, so a drift is worth surfacing rather than
    // silently trusting either number.
    const drift =
      seed.markersAtVerification > 0 &&
      Math.abs(outcome.skillsFound - seed.markersAtVerification) >
        Math.max(5, seed.markersAtVerification * 0.5)
        ? ` (was ${seed.markersAtVerification} at verification)`
        : "";

    report.results.push({
      repo: seed.repo,
      ok: true,
      detail:
        `${outcome.skillsFound} skill(s), ${outcome.licenseSpdx ?? "licence unresolved"}${drift}` +
        (seed.holdForReview ? " — held for review" : ""),
    });
  }

  await db.insert(events).values({
    actorType: "system",
    actorId: "crawl.seed",
    kind: "seeds.applied",
    subjectType: "sources",
    reason: "seed allow-list",
    payload: {
      attempted: report.attempted,
      added: report.added,
      alreadyKnown: report.alreadyKnown,
      failed: report.failed,
      skillsFound: report.skillsFound,
    },
  });

  return report;
}

export type ListReport = {
  list: string;
  filesRead: string[];
  linksSeen: number;
  candidates: number;
  inserted: number;
  alreadyKnown: number;
};

/**
 * Expands one curated list into candidate repositories.
 *
 * Writes candidates at `status: "new"` and does **not** enrich them here. Enrichment is one
 * API call per repository and a big list carries hundreds — doing it inline would turn a
 * list expansion into a rate-limit event. The existing bounded `enrichCandidates` step
 * already exists for exactly this, and it now has a queue worth working through.
 */
export async function expandList(
  input: { owner: string; repo: string; files?: readonly string[]; note?: string },
  options: { submittedBy: string } = { submittedBy: "system.seed" },
): Promise<ListReport> {
  const parsed = await fetchList(input);
  const listName = `${input.owner}/${input.repo}`;

  // The list itself becomes a source row, so re-reading it later is a normal sync and new
  // entries flow in without anyone editing seeds.ts.
  const listUrl = `https://github.com/${input.owner}/${input.repo}`;
  await db
    .insert(sources)
    .values({
      kind: "awesome_list",
      name: listName,
      url: listUrl,
      config: {
        discoveredBy: "seed-list",
        note: input.note ?? null,
        files: parsed.filesRead,
      },
      health: "healthy",
    })
    .onConflictDoNothing();

  let inserted = 0;
  let alreadyKnown = 0;

  for (const candidate of parsed.candidates) {
    const existing = await db
      .select({ id: discoveredRepos.id })
      .from(discoveredRepos)
      .where(
        and(
          eq(discoveredRepos.host, "github.com"),
          eq(discoveredRepos.owner, candidate.owner),
          eq(discoveredRepos.repo, candidate.repo),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      alreadyKnown += 1;
      // Still worth recording that a curator listed it — that is new evidence about a
      // repository we may previously have skipped on thin signal.
      await db
        .update(discoveredRepos)
        .set({ lastSeenAt: new Date() })
        .where(eq(discoveredRepos.id, existing[0].id));
      continue;
    }

    await db.insert(discoveredRepos).values({
      host: "github.com",
      owner: candidate.owner,
      repo: candidate.repo,
      url: candidate.url,
      // Unknown until enrichment; hitCount 0 distinguishes "a human listed this" from
      // "the crawl saw N markers", which is a genuinely different kind of evidence.
      hitCount: 0,
      status: "new",
      submittedBy: options.submittedBy,
      samplePaths: null,
    });
    inserted += 1;
  }

  await db.insert(events).values({
    actorType: "system",
    actorId: "crawl.seed",
    kind: "list.expanded",
    subjectType: "sources",
    reason: `curated list ${listName}`,
    payload: {
      list: listName,
      filesRead: parsed.filesRead,
      linksSeen: parsed.linksSeen,
      candidates: parsed.candidates.length,
      inserted,
      alreadyKnown,
    },
  });

  return {
    list: listName,
    filesRead: parsed.filesRead,
    linksSeen: parsed.linksSeen,
    candidates: parsed.candidates.length,
    inserted,
    alreadyKnown,
  };
}

/** Expands every list in the seed set. */
export async function applySeedLists(
  options: { submittedBy: string; onProgress?: (m: string) => void } = {
    submittedBy: "system.seed",
  },
): Promise<ListReport[]> {
  const log = options.onProgress ?? (() => {});
  const reports: ListReport[] = [];

  for (const list of SEED_LISTS as readonly SeedList[]) {
    const [owner, repo] = list.repo.split("/");
    log(`expanding ${list.repo}`);
    try {
      reports.push(
        await expandList(
          { owner, repo, files: list.files, note: list.note },
          { submittedBy: options.submittedBy },
        ),
      );
    } catch (error) {
      reports.push({
        list: list.repo,
        filesRead: [],
        linksSeen: 0,
        candidates: 0,
        inserted: 0,
        alreadyKnown: 0,
        ...{ error: (error as Error).message },
      } as ListReport);
    }
  }

  return reports;
}
