import "server-only";

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { activeBlocks } from "@/server/compliance/takedown";
import { githubConnector } from "@/server/connectors/github";
import type { Connector, SourceConfig } from "@/server/connectors/types";
import { discoveryPolicy, ingestPolicy } from "@/server/crawl/policy";
import { mapWithConcurrency } from "@/server/lib/concurrency";
import { beat } from "@/server/pipeline/heartbeat";
import { db } from "@/server/db";
import {
  discoveredRepos,
  events,
  skills,
  skillSignals,
  skillVersions,
  sources,
} from "@/server/db/schema";
import { resolveLicense } from "@/server/licensing/resolve";
import { normalizeSkill } from "@/server/skills/normalize";
import {
  bundlePrefix,
  digestBundle,
  mayMirror,
  storeBundle,
  type StorageTier,
} from "@/server/storage";

/**
 * One sync pass over one source.
 *
 * The order is the point: fetch, normalise, resolve the licence, hash, and only then
 * decide whether the bytes may be written. Analysis never depends on mirroring, so a
 * skill we may not copy is still indexed, still gets verdicts, and still counts in
 * corpus statistics — it simply has no bytes on our disk.
 *
 * Idempotent by `content_hash`: re-running touches `last_seen_at` and writes nothing
 * else. That is what makes an interrupted run safe to repeat.
 *
 * Nothing here reaches `indexed`. Versions land as `pending` and validation (1d) is what
 * promotes them — fail-closed by construction, not by remembering to check.
 */

const CONNECTORS: Record<string, Connector> = {
  github_repo: githubConnector,
};

/** Connector signal names -> the `signal_kind` enum. Not the same spelling. */
const SIGNAL_KINDS: Record<string, "stars" | "forks" | "watchers" | "open_issues"> = {
  stars: "stars",
  forks: "forks",
  watchers: "watchers",
  openIssues: "open_issues",
};

export type SyncOptions = {
  sourceUrl: string;
  /** Restrict to path prefixes, e.g. ["skills/"]. */
  includePaths?: string[];
  /**
   * Refuse to fetch a source whose enumeration exceeds this many skills.
   *
   * For callers that run under a hard ceiling they cannot negotiate with — the scheduled
   * pass, above all. A source is fetched completely or not at all (a partial enumeration
   * would make R1.5 tombstone everything it did not reach), so the only safe way to bound
   * one is to decide *before* fetching starts, using the count enumeration already gives us
   * for free.
   */
  maxSkills?: number;
  ref?: string;
  /** Public corpus when null. */
  orgId?: string | null;
  /** Walk everything but write nothing — for inspecting a source before trusting it. */
  dryRun?: boolean;
  /** Stop after N skills. Useful on a first look at a large repo. */
  limit?: number;
  /**
   * Sync a repository that exceeds the marker-count threshold anyway. Off by default and
   * never set by the automated path — this is for a human who has looked and decided.
   */
  allowLargeRepo?: boolean;
  onProgress?: (message: string) => void;
};

export type SyncedSkill = {
  path: string;
  name: string;
  slug: string;
  dialect: string;
  contentHash: string;
  licenseSpdx: string | null;
  redistribution: string;
  licenseSource: string;
  licenseFrom: string | null;
  contentStored: boolean;
  fileCount: number;
  byteSize: number;
  outcome: "created" | "unchanged" | "relicensed" | "dry-run";
  parseError: string | null;
};

/**
 * A source deliberately withheld, not a source that broke.
 *
 * Thrown so a direct `pnpm sync <url>` still fails loudly — an operator who asked for one
 * repository must not be told "done" when nothing was fetched. But the *pipeline* has to
 * tell this apart from a real fault: the marker gate firing is policy working, and counting
 * it as a failure trains everyone to ignore the failure count, which is where a genuine
 * error then hides.
 *
 * A typed error rather than a parsed message, for the reason `holdForReview` already writes
 * structured `healthDetail`: reading a decision back out of prose is how a caller quietly
 * starts skipping the cases it cannot parse.
 */
export class SourceHeldForReviewError extends Error {
  readonly url: string;
  readonly markerCount: number;
  readonly threshold: number;

  constructor(url: string, markerCount: number, threshold: number) {
    super(
      `${url} holds ${markerCount} skills, over the ${threshold} threshold — held for ` +
        // The remedy has to be something the reader can actually type. `allowLargeRepo` is
        // a config key, not a flag: it is set by an admin submission or by approving the
        // source in Settings → Review, and naming the key sent operators looking for a
        // command line that does not exist.
        `review, source disabled. Sync it anyway with: pnpm submit ${url}`,
    );
    this.name = "SourceHeldForReviewError";
    this.url = url;
    this.markerCount = markerCount;
    this.threshold = threshold;
  }
}

export type SyncReport = {
  sourceUrl: string;
  commitSha: string | null;
  skills: SyncedSkill[];
  signals: Record<string, number>;
  created: number;
  unchanged: number;
  /**
   * Same bytes, new licence answer — a correction rather than a new version.
   *
   * Counted separately because it means something different to an operator: the corpus did
   * not grow, but skills that were indexed-and-unservable may now be downloadable.
   */
  relicensed: number;
  /** Skills withdrawn because they are gone upstream (R1.5). */
  tombstoned: number;
  /** Skills not fetched because an upheld takedown blocks them (R7.5). */
  blocked: number;
  /** True when the source was too large for this caller and was left for a dedicated run. */
  deferred?: boolean;
  deferredReason?: string;
  /**
   * Skills that could not be fetched, with why.
   *
   * Reported rather than thrown: a repository is not unusable because one directory in it
   * confuses detection, and a count with no reasons is a number nobody can act on.
   */
  failedSkills: Array<{ path: string; reason: string }>;
};

/**
 * Sources that have never completed a sync, newest promotions first.
 *
 * Kept here rather than in the CLI because the cron dispatcher will need exactly the same
 * query — the trigger changes, the selection should not.
 */
/**
 * How long a synced source may go before it is due again (Doc 2 R7.4).
 *
 * The spec asks that upstream changes be detected within 24 hours, so a source older than
 * that is due. Nothing re-reads a repository except a sync, so this interval is also what
 * bounds how long a deleted skill keeps being served (R1.5) and how stale a verdict may be.
 */
const FRESHNESS_HOURS = 24;

/**
 * What to sync next: never-synced sources first, then the stale ones.
 *
 * The ordering carries the whole design. This used to select `lastSuccessAt IS NULL` and
 * nothing else, which meant the scheduler had exactly one job — initial catch-up — and went
 * permanently idle the moment it finished. No drift detection, no revocation, no freshness:
 * R7.4's 24-hour target could never be met by the only thing running on a timer.
 *
 * Never-synced first because a source contributing nothing is a bigger gap than a source
 * that is a day out of date, and because it keeps a catch-up run doing catch-up rather than
 * refreshing things it has already read. Once that queue empties, the same query starts
 * returning stale sources and the schedule becomes a freshness loop with no change in
 * behaviour anywhere else.
 */
export async function pendingSources(limit = 10) {
  return db
    .select({ id: sources.id, url: sources.url, name: sources.name })
    .from(sources)
    .where(
      and(
        eq(sources.enabled, true),
        // A curated list is a *discovery* source, not a content source: it is read for the
        // repository links inside it, by `expandList`, and it holds no skills of its own.
        // Syncing one would either find nothing or — worse — ingest the list repository's
        // own README as a skill. Expanding it is the equivalent operation, and it belongs
        // to the crawl, not to the fetch pipeline.
        ne(sources.kind, "awesome_list"),
        or(
          isNull(sources.lastSuccessAt),
          sql`${sources.lastSuccessAt} < now() - make_interval(hours => ${FRESHNESS_HOURS})`,
        ),
      ),
    )
    // NULLS FIRST is the point: never-synced sources sort ahead of merely-stale ones.
    .orderBy(sql`${sources.lastSuccessAt} asc nulls first`, sources.createdAt)
    .limit(limit);
}

export async function syncSource(options: SyncOptions): Promise<SyncReport> {
  const orgId = options.orgId ?? null;
  const log = options.onProgress ?? (() => {});

  /**
   * Curator decisions live on the source, not in the caller's arguments — so the scheduled
   * path honours them too, not just a hand-run command with the right flags.
   *
   * `allowLargeRepo` already worked this way. `includePaths` did not, and that was a silent
   * hole: narrowing `liferay/liferay-portal` to `workspaces/` was recorded on the source
   * and then ignored by every sync that did not re-type `--include`, so the tree call kept
   * truncating and the sync kept failing for a reason the curator had already fixed.
   */
  const [sourceRow] = await db
    .select({ config: sources.config })
    .from(sources)
    .where(eq(sources.url, options.sourceUrl))
    .limit(1);
  const sourceConfig = (sourceRow?.config ?? {}) as Record<string, unknown>;

  const approvedLarge = sourceConfig.allowLargeRepo === true;
  const storedIncludePaths = Array.isArray(sourceConfig.includePaths)
    ? (sourceConfig.includePaths as unknown[]).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];

  // An explicit argument wins — a one-off run should be able to look somewhere else
  // without rewriting the source's stored configuration.
  const includePaths = options.includePaths?.length ? options.includePaths : storedIncludePaths;

  const config: SourceConfig = {
    url: options.sourceUrl,
    ref: options.ref,
    includePaths: includePaths.length > 0 ? includePaths : undefined,
  };

  /**
   * Takedowns, read before anything is fetched (R7.5).
   *
   * Ahead of enumeration on purpose. A withdrawn repository should cost us one query, not
   * two GitHub calls and a tree walk — and more importantly, "we did not fetch it" is a
   * stronger statement than "we fetched it and then declined to store it". Content we were
   * asked to stop copying should not be copied into memory either.
   *
   * The source is also disabled when a source-scoped takedown is upheld, so `pendingSources`
   * stops offering it. This check is the backstop for every other way in: a hand-run
   * `pnpm sync <url>`, an admin re-submission, a caller passing the URL directly.
   */
  const blocks = await activeBlocks(options.sourceUrl);
  if (blocks.sourceBlocked) {
    log(`${options.sourceUrl} is withdrawn on request — nothing fetched`);
    return {
      sourceUrl: options.sourceUrl,
      commitSha: null,
      skills: [],
      signals: {},
      created: 0,
      unchanged: 0,
      relicensed: 0,
      tombstoned: 0,
      blocked: 0,
      failedSkills: [],
      deferred: true,
      deferredReason: "withdrawn on request — an upheld takedown covers this source",
    };
  }

  const connector = CONNECTORS.github_repo;
  log(`enumerating ${options.sourceUrl}`);
  const enumerated = await connector.enumerate(config, null);
  log(`found ${enumerated.refs.length} skill(s)`);

  /**
   * Re-check the marker count against the real tree.
   *
   * Promotion applies this same threshold to the count code search *sampled*, which is
   * one shard's worth — `pm-claude-skills` showed 11 markers at discovery and actually
   * holds 3,551. Discovery guesses; the tree knows. Checking only at discovery let a
   * clone farm through and turned one source into thousands of file fetches.
   *
   * Held for review rather than skipped, and the source is disabled so the queue stops
   * retrying it — the same posture as promotion, for the same reason: it may still hold
   * real skills.
   */
  if (
    !options.allowLargeRepo &&
    !approvedLarge &&
    !options.dryRun &&
    enumerated.refs.length > discoveryPolicy.markerCountReviewThreshold
  ) {
    await holdForReview(
      options.sourceUrl,
      enumerated.refs.length,
      orgId,
      "marker-threshold",
      discoveryPolicy.markerCountReviewThreshold,
    );
    throw new SourceHeldForReviewError(
      options.sourceUrl,
      enumerated.refs.length,
      discoveryPolicy.markerCountReviewThreshold,
    );
  }

  /**
   * Too large for this caller's budget: defer rather than start.
   *
   * The scheduled pass has ~13 minutes. A repository with hundreds of skills needs more
   * than that, and because a source must be fetched completely, starting one is committing
   * to finishing it. The Vercel cron timed out at exactly 800 s doing this — and, worse,
   * left the source unsynced, so the next tick would have picked the same one and timed out
   * again, every ten minutes, indefinitely.
   *
   * Held for review rather than skipped, so it lands in the queue a curator already watches
   * and can be synced deliberately with `pnpm sync <url>`, which has no ceiling.
   */
  if (options.maxSkills && enumerated.refs.length > options.maxSkills) {
    await holdForReview(
      options.sourceUrl,
      enumerated.refs.length,
      orgId,
      "pass-ceiling",
      options.maxSkills,
    );
    return {
      sourceUrl: options.sourceUrl,
      commitSha: enumerated.refs[0]?.commitSha ?? null,
      skills: [],
      signals: Object.fromEntries(
        Object.entries(enumerated.signals).filter(([, v]) => typeof v === "number"),
      ) as Record<string, number>,
      created: 0,
      unchanged: 0,
      relicensed: 0,
      tombstoned: 0,
      blocked: 0,
      failedSkills: [],
      deferred: true,
      deferredReason: `${enumerated.refs.length} skills — over the ${options.maxSkills} this caller may fetch`,
    };
  }

  const refs = options.limit ? enumerated.refs.slice(0, options.limit) : enumerated.refs;

  /**
   * Was this a complete view of the repository?
   *
   * Only then can "absent from the enumeration" mean "deleted upstream". A `--limit`, a
   * dry run, or an `includePaths` narrowing each produce a partial view, and treating any
   * of them as authoritative would tombstone everything the run did not look at.
   */
  const completeEnumeration =
    !options.limit && !options.dryRun && includePaths.length === 0;
  const report: SyncReport = {
    sourceUrl: options.sourceUrl,
    commitSha: refs[0]?.commitSha ?? null,
    skills: [],
    signals: Object.fromEntries(
      Object.entries(enumerated.signals).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    created: 0,
    unchanged: 0,
    relicensed: 0,
    tombstoned: 0,
    blocked: 0,
    failedSkills: [],
  };

  const sourceId = options.dryRun
    ? null
    : await upsertSource(options.sourceUrl, orgId, enumerated.repoLicenseSpdx);

  /**
   * Skills in parallel, at the same width as every other bundle-shaped stage.
   *
   * Per skill the work is: fetch its files (already concurrent *within* a skill), upload
   * them to R2, then one short transaction. All of that is network-bound, and doing it one
   * skill at a time made a 6,864-skill repository take an hour and three quarters.
   *
   * Two things make this safe rather than merely faster. Each skill owns its own bundle and
   * its own transaction, so lanes share no state — `report` counters are mutated between
   * awaits on a single-threaded loop, never across one. And the one genuine race, two
   * skills with byte-identical content inserting at once, is handled in `writeSkillVersion`
   * where the constraint lives; see the note there.
   *
   * `seenPaths` for tombstoning is built from the **enumeration**, not from this loop, so a
   * skill that fails here is still "seen" and is never mistaken for one deleted upstream —
   * unchanged by concurrency, and worth restating because it is the property that would be
   * most expensive to break.
   */
  const sourceName = options.sourceUrl.replace(/^https?:\/\/github\.com\//, "");

  await mapWithConcurrency(refs, ingestPolicy.bundleConcurrency, async (ref) => {
    /**
     * One skill failing must not cost the rest of the repository.
     *
     * Without this the loop was all-or-nothing, and it showed:
     * `davila7/claude-code-templates` holds 898 skills, one of which
     * (`cli-tool/components/skills/ai-research/loki-mode`) trips the 300-file bundle
     * backstop because detection reads a project directory as a skill. That single throw
     * aborted the entire source and lost the other 897 — twice, silently, reported only as
     * "2 failed" in a pipeline summary.
     *
     * Tombstoning stays correct: `seenPaths` is built from the full enumeration, not from
     * what was successfully fetched, so a skill that failed to fetch is still *seen* and is
     * not mistaken for one deleted upstream.
     */
    /**
     * A blocked path is skipped before the fetch, never after.
     *
     * This is the line that makes a takedown mean something. Everything else — the status,
     * the deleted objects, the notice on the page — is undone by one enumeration finding
     * the file again, because that is exactly what the tombstone path is built to do.
     *
     * Tombstoning stays correct without a special case: `seenPaths` comes from the full
     * enumeration, so a blocked skill is still *seen* and is not mistaken for one deleted
     * upstream, and `withdrawn` is not among the statuses `tombstoneMissing` will touch.
     */
    if (blocks.paths.has(ref.path)) {
      report.blocked += 1;
      log(`  withdrawn ${ref.path || "."} — takedown upheld`);
      return; // a worker callback now, not a loop body
    }

    let fetched: Awaited<ReturnType<typeof connector.fetch>>;
    try {
      fetched = await connector.fetch(config, ref);
    } catch (error) {
      report.failedSkills.push({
        path: ref.path || "(root)",
        reason: (error as Error).message.slice(0, 200),
      });
      log(`  skipped   ${ref.path || "."} — ${(error as Error).message.slice(0, 120)}`);
      return;
    }

    const dirName = ref.path.split("/").pop() || "root";

    const marker = fetched.files[0];
    const normalized = normalizeSkill({
      dialect: ref.dialect,
      dirName,
      markerContent: marker.content,
    });

    const license = resolveLicense({
      frontmatterLicense: normalized.frontmatterLicense,
      licenseFiles: fetched.licenseFiles.map((file) => ({
        path: file.path,
        text: file.content.toString("utf8"),
      })),
      repoLicenseSpdx: enumerated.repoLicenseSpdx,
    });

    // Hash first, always. Storing is the only part the licence gate can withhold, and a
    // dry run must still report the hash and the decision it *would* make.
    const tier: StorageTier = "public";
    const digest = digestBundle(fetched.files);
    const permitted = mayMirror(license.posture);
    const stored = options.dryRun
      ? {
          ...digest,
          storageKey: permitted ? bundlePrefix(tier, digest.contentHash) : null,
          contentStored: permitted,
        }
      : await storeBundle({
          files: fetched.files,
          tier,
          redistribution: license.posture,
          licenseSpdx: license.spdx,
        });

    const entry: SyncedSkill = {
      path: ref.path,
      name: normalized.name,
      slug: normalized.slug,
      dialect: normalized.dialect,
      contentHash: stored.contentHash,
      licenseSpdx: license.spdx,
      redistribution: license.posture,
      licenseSource: license.source,
      licenseFrom: license.evidence.from,
      contentStored: stored.contentStored,
      fileCount: stored.fileCount,
      byteSize: stored.byteSize,
      outcome: "dry-run",
      parseError: normalized.parseError,
    };

    if (!options.dryRun && sourceId) {
      /**
       * The write is inside the per-skill failure handling, and it was not before.
       *
       * The `try` above covered only the fetch, so a database error here escaped the worker
       * and cost the **entire repository** — 6,864 skills lost to one row. Sequentially that
       * was latent; concurrency made it fire, because two identical bundles racing the
       * `content_hash` unique index is a routine event in a mirror repo.
       *
       * Same rule as everywhere else in this loop: one bad skill is reported and skipped,
       * never charged to the other 6,863.
       */
      try {
        const outcome = await writeSkillVersion({
          orgId,
          sourceId,
          ref,
          normalized,
          license,
          stored,
          sourceUrl: options.sourceUrl,
          signals: enumerated.signals,
        });
        entry.outcome = outcome;
        if (outcome === "created") report.created += 1;
        else if (outcome === "relicensed") report.relicensed += 1;
        else report.unchanged += 1;
      } catch (error) {
        report.failedSkills.push({
          path: ref.path || "(root)",
          reason: (error as Error).message.slice(0, 200),
        });
        log(`  failed    ${ref.path || "."} — ${(error as Error).message.slice(0, 120)}`);
        return;
      }
    }

    report.skills.push(entry);
    log(`  ${entry.outcome.padEnd(9)} ${ref.path || "."} — ${entry.redistribution}`);

    /**
     * The beat that closes the diagnostic gap.
     *
     * This is the loop that goes quiet for hours on a large repository, and it is exactly
     * where all three stalls happened. Throttled inside `beat` to once every fifteen
     * seconds, so calling it per skill costs nothing at 2.6 skills a second.
     */
    await beat(
      "sync",
      `${sourceName} — ${report.skills.length}/${refs.length} skills`,
      { done: report.skills.length, total: refs.length },
    );
  });

  // Withdraw anything this source used to have and no longer does (R1.5). Guarded on a
  // complete enumeration — see `tombstoneMissing`.
  if (completeEnumeration && sourceId) {
    report.tombstoned = await tombstoneMissing({
      sourceId,
      orgId,
      seenPaths: enumerated.refs.map((ref) => ref.path),
      sourceUrl: options.sourceUrl,
    });
    if (report.tombstoned > 0) {
      log(`  tombstoned ${report.tombstoned} skill(s) no longer present upstream`);
    }
  }

  if (!options.dryRun && sourceId) {
    await db
      .update(sources)
      .set({ lastSyncAt: new Date(), lastSuccessAt: new Date(), health: "healthy" })
      .where(eq(sources.id, sourceId));
  }

  return report;
}

/** First free slug: `name`, then `name-2`, `name-3`, … within the same corpus. */
async function uniqueSlug(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  base: string,
  orgId: string | null,
): Promise<string> {
  for (let attempt = 1; attempt < 500; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const [taken] = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.slug, candidate),
          orgId === null ? isNull(skills.orgId) : eq(skills.orgId, orgId),
        ),
      )
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Disables a source and returns its candidate row to the review queue, with the reason. */
/**
 * Which gate stopped this source. They are different decisions and must not share a record.
 *
 *   - `marker-threshold` — the repository is large enough that a curator should look before
 *     we ingest it. A judgement about the *repository*, and it stands until someone decides.
 *   - `pass-ceiling` — this caller could not finish it inside its own budget. A statement
 *     about the *caller*, not the repo: a local `pnpm sync <url>` has no ceiling and will
 *     complete the same source without complaint.
 *
 * Recorded because the reason used to be a lie. Both gates called `holdForReview`, which
 * stamped the marker threshold into the sentence whatever had actually fired — so a
 * 384-skill repository stopped by a 120-skill pass ceiling was filed as
 * "384 skills in one repository — over the 500 threshold", which is arithmetically false and
 * sends whoever reads it looking for the wrong knob.
 */
export type HoldKind = "marker-threshold" | "pass-ceiling";

async function holdForReview(
  url: string,
  markerCount: number,
  orgId: string | null,
  kind: HoldKind,
  threshold: number,
): Promise<void> {
  const reason =
    kind === "marker-threshold"
      ? `${markerCount} skills in one repository — over the ${threshold} review threshold`
      : `${markerCount} skills — more than the ${threshold} this pass may fetch; ` +
        `sync it directly with pnpm sync ${url}, which has no ceiling`;

  await db.transaction(async (tx) => {
    await tx
      .update(sources)
      // Structured, not just a sentence: `reapplyMarkerThreshold` has to re-judge this
      // decision after the threshold moves, and parsing a number back out of prose is how
      // a re-evaluation quietly starts skipping rows it cannot read. `heldBy` is part of
      // that contract now — the sweep releases a pass-ceiling hold unconditionally, because
      // nobody decided anything about the repository.
      .set({
        enabled: false,
        health: "paused",
        healthDetail: { reason, markerCount, threshold, heldBy: kind },
        updatedAt: new Date(),
      })
      .where(eq(sources.url, url));

    await tx
      .update(discoveredRepos)
      .set({ status: "needs_review", skipReason: reason })
      .where(eq(discoveredRepos.url, url));

    await tx.insert(events).values({
      orgId,
      actorType: "system",
      actorId: "ingest",
      kind: "source.held_for_review",
      subjectType: "sources",
      subjectId: null,
      reason,
      payload: { url, markerCount, threshold, heldBy: kind },
    });
  });
}

async function upsertSource(
  url: string,
  orgId: string | null,
  repoLicenseSpdx: string | null,
): Promise<string> {
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.url, url), orgId === null ? isNull(sources.orgId) : eq(sources.orgId, orgId)))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(sources)
    .values({
      orgId,
      kind: "github_repo",
      name: url.replace(/^https?:\/\/(www\.)?github\.com\//i, ""),
      url,
      config: { repoLicenseSpdx },
      health: "healthy",
    })
    .returning({ id: sources.id });

  return row.id;
}


/**
 * Tombstones skills that have disappeared upstream (R1.5).
 *
 * Identity is `(source, path)`, the same key the write path uses. Anything this source
 * previously produced whose path is absent from a *complete* enumeration is gone upstream —
 * deleted, renamed, or moved out of the crawled prefixes.
 *
 * Tombstoning keeps the metadata and withdraws the content: the row, its provenance and its
 * verdicts stay, so a link to it can still explain what it was and why it is no longer
 * served. Deleting would erase the audit trail for a skill somebody may have installed.
 *
 * ## The guard is the important part
 *
 * This only runs on a full enumeration. A `--limit`ed run, a dry run, or a run narrowed by
 * `includePaths` all produce a partial view of the repository, and treating a partial view
 * as authoritative would tombstone every skill the run simply did not look at. That failure
 * would be silent, would look like successful upstream deletions, and would empty the
 * corpus one truncated sync at a time. The caller passes `complete: false` whenever the
 * enumeration was bounded for any reason.
 */
export async function tombstoneMissing(input: {
  sourceId: string;
  orgId: string | null;
  seenPaths: string[];
  sourceUrl: string;
}): Promise<number> {
  const { sourceId, orgId, seenPaths, sourceUrl } = input;

  const live = await db
    .select({
      id: skillVersions.id,
      skillId: skillVersions.skillId,
      path: sql<string>`${skillVersions.provenance}->>'path'`,
    })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.sourceId, sourceId),
        inArray(skillVersions.status, ["indexed", "quarantined", "pending", "revalidating"]),
      ),
    );

  const seen = new Set(seenPaths);
  const gone = live.filter((row) => row.path !== null && !seen.has(row.path));
  if (gone.length === 0) return 0;

  await db.transaction(async (tx) => {
    if (orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    }

    for (const row of gone) {
      await tx
        .update(skillVersions)
        .set({ status: "tombstoned", contentStored: false, storageKey: null })
        .where(eq(skillVersions.id, row.id));

      // Only un-list the skill if this was the version being served. A skill whose newer
      // version vanished but whose older one is still indexed stays listed on the older.
      const [remaining] = await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, row.skillId),
            eq(skillVersions.status, "indexed"),
            ne(skillVersions.id, row.id),
          ),
        )
        .orderBy(desc(skillVersions.syncedAt))
        .limit(1);

      await tx
        .update(skills)
        .set({
          status: remaining ? "indexed" : "tombstoned",
          currentVersionId: remaining?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, row.skillId));

      await tx.insert(events).values({
        orgId,
        actorType: "system",
        actorId: "ingest",
        kind: "skill_version.tombstoned",
        subjectType: "skill_versions",
        subjectId: row.id,
        reason: "no longer present upstream",
        payload: { path: row.path, sourceUrl },
      });
    }
  });

  return gone.length;
}

type WriteInput = {
  orgId: string | null;
  sourceId: string;
  ref: { path: string; commitSha: string; files: string[] };
  normalized: ReturnType<typeof normalizeSkill>;
  license: ReturnType<typeof resolveLicense>;
  stored: Awaited<ReturnType<typeof storeBundle>>;
  sourceUrl: string;
  signals: Record<string, number | undefined>;
};

/**
 * Postgres unique-violation.
 *
 * The one race concurrency introduces: two skills with byte-identical content can both pass
 * the duplicate lookup and both insert, and the partial unique index on `content_hash`
 * refuses the second. That is not an error — it is the dedup rule working, arrived at from
 * the other direction — so it is caught and reported as `unchanged`.
 *
 * A repository full of copies is exactly where this fires, and exactly where the corpus most
 * needs the sync to keep going: one such source held 6,864 skills, every one already known.
 */
function isUniqueViolation(error: unknown): boolean {
  // Walk the cause chain. Drizzle wraps every driver error in its own `Error` whose message
  // is the failed SQL, so the Postgres `code` is never on the object you first catch —
  // checking the top level silently matches nothing, which is exactly how the first version
  // of this guard passed review and then caught none of the violations it was written for.
  for (let e: unknown = error, hops = 0; e && hops < 5; hops += 1) {
    if (typeof e === "object" && e !== null) {
      if ((e as { code?: unknown }).code === "23505") return true;
      e = (e as { cause?: unknown }).cause;
    } else break;
  }
  return false;
}

async function writeSkillVersion(
  input: WriteInput,
): Promise<"created" | "unchanged" | "relicensed"> {
  try {
    return await writeSkillVersionOnce(input);
  } catch (error) {
    if (isUniqueViolation(error)) return "unchanged";
    throw error;
  }
}

async function writeSkillVersionOnce(
  input: WriteInput,
): Promise<"created" | "unchanged" | "relicensed"> {
  const { orgId, sourceId, ref, normalized, license, stored } = input;

  return db.transaction(async (tx) => {
    if (orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    }

    // Dedup (R1.4): identical bytes from any source collapse to the existing version.
    const [duplicate] = await tx
      .select({
        id: skillVersions.id,
        skillId: skillVersions.skillId,
        sourceId: skillVersions.sourceId,
        path: sql<string | null>`${skillVersions.provenance}->>'path'`,
        redistribution: skillVersions.redistribution,
        licenseSource: skillVersions.licenseSource,
        contentStored: skillVersions.contentStored,
        status: skillVersions.status,
      })
      .from(skillVersions)
      .where(eq(skillVersions.contentHash, stored.contentHash))
      .limit(1);

    if (duplicate) {
      await tx
        .update(skills)
        .set({ lastSeenAt: new Date() })
        .where(eq(skills.id, duplicate.skillId));

      /**
       * Unchanged bytes did not mean unchanged licence, and that used to be silently lost.
       *
       * This branch returned early, so a re-sync discarded the licence the chain had just
       * resolved. It only mattered once the chain got better: adding Creative Commons body
       * patterns re-classified a 166-skill repository from `unresolved` to
       * `attribution_required`, `storeBundle` above dutifully uploaded the bytes — and the
       * row kept saying unresolved, so nothing became downloadable. A resolver improvement
       * that cannot reach already-synced rows is a resolver improvement nobody sees.
       *
       * **Only for the same (source, path).** The dedup lookup matches on content hash
       * across every source, so the row found here may belong to a *different* repository
       * that happens to ship identical bytes. That repository's copy is governed by its own
       * licence chain, and overwriting its posture from ours would be exactly the
       * cross-source contamination R1.6 exists to prevent.
       *
       * Withdrawn and tombstoned rows are left alone: restoring a licence on content a
       * takedown removed would undo the takedown on a schedule, which is the failure R7.5
       * is built around.
       */
      const sameSkill = duplicate.sourceId === sourceId && duplicate.path === ref.path;
      const servable = duplicate.status === "indexed" || duplicate.status === "quarantined";
      const licenceMoved =
        duplicate.redistribution !== license.posture ||
        duplicate.licenseSource !== license.source ||
        duplicate.contentStored !== stored.contentStored;

      if (sameSkill && servable && licenceMoved) {
        await tx
          .update(skillVersions)
          .set({
            licenseSpdx: license.spdx,
            redistribution: license.posture,
            licenseSource: license.source,
            licenseEvidence: license.evidence,
            contentStored: stored.contentStored,
            storageKey: stored.storageKey,
          })
          .where(eq(skillVersions.id, duplicate.id));

        // A posture change decides whether content is served, so it is a state transition
        // R7.1 wants recorded — not a quiet correction.
        await tx.insert(events).values({
          orgId,
          actorType: "system",
          kind: "licence.reresolved",
          subjectType: "skill_version",
          subjectId: duplicate.id,
          reason: `${duplicate.redistribution} → ${license.posture} (${license.source})`,
          payload: {
            path: ref.path,
            spdx: license.spdx,
            from: duplicate.redistribution,
            to: license.posture,
            contentStored: stored.contentStored,
          },
        });

        return "relicensed" as const;
      }

      return "unchanged" as const;
    }

    /**
     * Skill identity is (source, path) — the same directory in the same repo is the same
     * skill across syncs, so changed content becomes a new *version* rather than a second
     * skill. Slug is not identity: two unrelated repos both ship a "pdf" skill, and those
     * really are different skills.
     */
    const [existing] = await tx
      .select({ id: skills.id })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .where(
        and(
          eq(skillVersions.sourceId, sourceId),
          sql`${skillVersions.provenance}->>'path' = ${ref.path}`,
        ),
      )
      .limit(1);

    let skillId: string;
    if (existing) {
      skillId = existing.id;
      await tx
        .update(skills)
        .set({
          lastSeenAt: new Date(),
          name: normalized.name,
          summary: normalized.summary,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, skillId));
    } else {
      /**
       * Slugs must identify exactly one skill.
       *
       * The unique index is `(org_id, slug)` and Postgres treats NULLs as distinct, so
       * nothing stopped 66 public skills all being `agent-hiring-panel` — and
       * `/skills/agent-hiring-panel` then resolved to an arbitrary one. Suffix on
       * collision so the URL stays readable and unambiguous.
       */
      const slug = await uniqueSlug(tx, normalized.slug, orgId);
      const [created] = await tx
        .insert(skills)
        .values({
          orgId,
          dialect: normalized.dialect,
          name: normalized.name,
          slug,
          summary: normalized.summary,
          status: "pending",
        })
        .returning({ id: skills.id });
      skillId = created.id;
    }

    const [version] = await tx
      .insert(skillVersions)
      .values({
        orgId,
        skillId,
        sourceId,
        contentHash: stored.contentHash,
        storageKey: stored.storageKey,
        contentStored: stored.contentStored,
        byteSize: stored.byteSize,
        fileCount: stored.fileCount,
        frontmatter: normalized.frontmatter,
        provenance: {
          sourceUrl: input.sourceUrl,
          path: ref.path,
          commitSha: ref.commitSha,
          files: ref.files,
          fileHashes: stored.fileHashes,
          fetchedAt: new Date().toISOString(),
          parseError: normalized.parseError,
        },
        licenseSpdx: license.spdx,
        licenseSource: license.source,
        licenseEvidence: license.evidence,
        redistribution: license.posture,
        upstreamRef: ref.commitSha,
        /**
         * `revalidating` when this skill already had a version, `pending` when it is new
         * (R1.5).
         *
         * Both are unserved and both queue for validation, so the distinction is not about
         * gating — it is about being able to tell the two situations apart afterwards.
         * "Upstream changed under us" and "we have never seen this" need different
         * operational responses, and a single `pending` bucket cannot express which
         * happened.
         */
        status: existing ? "revalidating" : "pending",
      })
      .returning({ id: skillVersions.id });

    for (const [key, value] of Object.entries(input.signals)) {
      if (typeof value !== "number") continue;
      const kind = SIGNAL_KINDS[key];
      // An unmapped key means the connector reports something the schema does not model
      // yet — skip it rather than crash the whole sync on one extra field.
      if (!kind) continue;
      await tx
        .insert(skillSignals)
        .values({ orgId, skillId, sourceId, kind, value: String(value) })
        .onConflictDoNothing();
    }

    await tx.insert(events).values({
      orgId,
      actorType: "system",
      actorId: "ingest",
      kind: "skill_version.created",
      subjectType: "skill_versions",
      subjectId: version.id,
      reason: `synced from ${input.sourceUrl}`,
      payload: {
        path: ref.path,
        commitSha: ref.commitSha,
        contentHash: stored.contentHash,
        redistribution: license.posture,
        licenseSource: license.source,
        contentStored: stored.contentStored,
      },
    });

    return "created" as const;
  });
}

/**
 * Test seam for `verify-revocation.mts`.
 *
 * Named rather than exporting the internal directly so the verification script's dependency
 * on it is explicit — this is the one caller outside the sync path, and it exists so the
 * R1.5 rules can be proven without staging a real upstream deletion on GitHub.
 */
export const tombstoneForTest = tombstoneMissing;
