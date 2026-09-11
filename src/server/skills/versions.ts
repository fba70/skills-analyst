import "server-only";

import { eq, sql } from "drizzle-orm";

import {
  compareVersion,
  DRIFT_STEPS_BEFORE_SURFACING,
  stepsBehind,
  resolveVersioned,
  VERSIONED,
  versionedById,
  type DriftState,
  type VersionCheckState,
} from "@/lib/versions";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { db } from "@/server/db";
import { toolVersions } from "@/server/db/schema";
import { fetchWithDeadline } from "@/server/http/deadline";

/**
 * Version drift (Doc 7 RD.10, plan step P5) — the half of RK.2 that was never built.
 *
 * RK.2 promised *"your skill teaches Next 15 idioms; 16 changed X"*. Link rot and review dates
 * shipped; this did not, because nothing knew which projects a skill referenced. P0's pins and
 * P5's vocabulary close that.
 *
 * ## Drift is not rot, and nothing here may demote anything
 *
 * A skill teaching Next 15 idioms is **exactly right** for a codebase on Next 15. So this
 * produces a fact, shown beside the skill, and touches neither the lifecycle nor the quality
 * score nor the trust surfaces. `stale` — a review date somebody set and let pass — remains
 * the only freshness signal that changes a state, because that one is a governance decision a
 * human made. `verify:version-drift` asserts the derivation reaches no lifecycle expression.
 */

const GITHUB_API = "https://api.github.com";

export type VersionOutcome = {
  subject: string;
  status: VersionCheckState;
  version: string | null;
  releasedAt: Date | null;
  statusCode: number | null;
};

/**
 * Ask GitHub for a project's latest release.
 *
 * Through `fetchWithDeadline`, which is not optional: this walks third-party hosts, the
 * population that includes one which accepts a connection and never answers — the failure
 * that hung two ingestion runs for hours before every outbound call got a deadline.
 *
 * `blocked` and `unreachable` are kept apart from a real answer for the reason `checkLink`
 * keeps them apart: a 403 is a fact about our user agent and a timeout is a fact about the
 * network, and neither is a fact about the project. Only `ok` may change a stored version.
 */
export async function checkVersion(subject: string): Promise<VersionOutcome> {
  const thing = versionedById(subject);
  if (!thing) return { subject, status: "unreachable", version: null, releasedAt: null, statusCode: null };

  const feed = thing.releases;
  const url =
    feed.kind === "github"
      ? `${GITHUB_API}/repos/${feed.repo}/releases/latest`
      : `https://endoflife.date/api/${feed.product}.json`;

  try {
    const response = await fetchWithDeadline(url, {
      headers: {
        accept: feed.kind === "github" ? "application/vnd.github+json" : "application/json",
        "user-agent": "SkillsFoundryVersionCheck/1.0 (+https://github.com/skills-foundry)",
        ...(feed.kind === "github" && process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return { subject, status: "blocked", version: null, releasedAt: null, statusCode: response.status };
    }
    if (!response.ok) {
      return { subject, status: "unreachable", version: null, releasedAt: null, statusCode: response.status };
    }

    if (feed.kind === "github") {
      const body = (await response.json()) as { tag_name?: string; published_at?: string };
      /*
       * The tag, not the release *name*: a name is prose an author chose ("October release")
       * and a tag is what the ecosystem installs. `parseVersion` strips a leading `v` and
       * anything after the numbers, so `v1.24.2` and `swift-6.3.3-RELEASE` both read.
       */
      const tag = typeof body.tag_name === "string" ? body.tag_name : null;
      if (!tag) {
        return { subject, status: "unreachable", version: null, releasedAt: null, statusCode: response.status };
      }
      return {
        subject,
        status: "ok",
        version: tag,
        releasedAt: body.published_at ? new Date(body.published_at) : null,
        statusCode: response.status,
      };
    }

    /*
     * endoflife.date returns cycles newest first. The **first** is the answer, and taking the
     * maximum instead would be wrong in a way worth naming: these feeds list the newest cycle
     * first *including* ones not yet generally available, and reordering by version number
     * would silently prefer whichever pre-release sorted highest — which is exactly the trap
     * that made git tags unusable for these projects in the first place.
     */
    const cycles = (await response.json()) as Array<{ latest?: string; cycle?: string; latestReleaseDate?: string }>;
    const newest = Array.isArray(cycles) ? cycles[0] : null;
    const version = newest?.latest ?? newest?.cycle ?? null;
    if (!version) {
      return { subject, status: "unreachable", version: null, releasedAt: null, statusCode: response.status };
    }
    return {
      subject,
      status: "ok",
      version: String(version),
      releasedAt: newest?.latestReleaseDate ? new Date(newest.latestReleaseDate) : null,
      statusCode: response.status,
    };
  } catch {
    return { subject, status: "unreachable", version: null, releasedAt: null, statusCode: null };
  }
}

export type VersionCheckReport = {
  checked: number;
  ok: number;
  blocked: number;
  unreachable: number;
  outcomes: VersionOutcome[];
};

/**
 * Check every tracked project, and optionally store the result.
 *
 * Twenty requests a pass, not thousands — this is the cheapest recurring job in the codebase
 * and it is still not scheduled, because CLAUDE.md's rule is about what a schedule *implies*:
 * a job nobody watches is one nobody notices failing. It is a command.
 *
 * `dry` exists so the vocabulary can be verified before a migration is applied. Every release
 * feed in `VERSIONED` was confirmed to resolve this way before it was trusted, which is the
 * rule `seeds.ts` set after three hand-written entries turned out to be 404s.
 */
export async function checkVersions(
  options: { dry?: boolean; only?: string } = {},
): Promise<VersionCheckReport> {
  const subjects = options.only
    ? VERSIONED.filter((v) => v.id === options.only)
    : VERSIONED;

  const report: VersionCheckReport = { checked: 0, ok: 0, blocked: 0, unreachable: 0, outcomes: [] };

  for (const thing of subjects) {
    const outcome = await checkVersion(thing.id);
    report.checked += 1;
    report[outcome.status] += 1;
    report.outcomes.push(outcome);
    if (options.dry) continue;

    /*
     * A failure never clears a version we already know. The streak is recorded and the last
     * good answer is kept, because "GitHub was rate-limiting us on Tuesday" must not read to
     * an author as "this project has no releases" — the same reasoning that made a single
     * failed link check not rot.
     */
    await db
      .insert(toolVersions)
      .values({
        subject: thing.id,
        currentVersion: outcome.version,
        releasedAt: outcome.releasedAt,
        status: outcome.status,
        statusCode: outcome.statusCode,
        consecutiveFailures: outcome.status === "ok" ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: toolVersions.subject,
        set:
          outcome.status === "ok"
            ? {
                currentVersion: outcome.version,
                releasedAt: outcome.releasedAt,
                status: "ok",
                statusCode: outcome.statusCode,
                consecutiveFailures: 0,
                checkedAt: new Date(),
              }
            : {
                status: outcome.status,
                statusCode: outcome.statusCode,
                consecutiveFailures: sql`${toolVersions.consecutiveFailures} + 1`,
                checkedAt: new Date(),
              },
      });
  }

  return report;
}

export type VersionDrift = {
  subject: string;
  label: string;
  pinned: string;
  current: string;
  releasedAt: Date | null;
  state: DriftState;
  /** How far behind in the unit the project moves in — majors, or minors where that is the unit. */
  stepsBehind: number | null;
};

/** What is stored, keyed by subject. One read, so a page of skills costs one query. */
async function currentVersions(): Promise<Map<string, { version: string; releasedAt: Date | null }>> {
  const rows = await db
    .select({
      subject: toolVersions.subject,
      currentVersion: toolVersions.currentVersion,
      releasedAt: toolVersions.releasedAt,
    })
    .from(toolVersions)
    .where(eq(toolVersions.status, "ok"));
  const out = new Map<string, { version: string; releasedAt: Date | null }>();
  for (const row of rows) {
    if (row.currentVersion) out.set(row.subject, { version: row.currentVersion, releasedAt: row.releasedAt });
  }
  return out;
}

/**
 * Drift for one skill version, derived from its stored pins.
 *
 * **The vocabulary filters here, at read time**, which is why `version_pins` keeps every
 * candidate the regex produced: `if`, `is`, `rate` and `count` are in that column and none of
 * them resolves, so none of them reaches a reader. Widening `VERSIONED` is a query rather than
 * a 2.5-hour re-extract — the same architecture `skill_tools` has against `tool_refs`.
 */
export async function driftForVersion(skillVersionId: string): Promise<VersionDrift[]> {
  const { rows } = await db.execute<{ tool: string; version: string }>(sql`
    select p->>'tool' as tool, p->>'version' as version
      from skill_structures s, jsonb_array_elements(s.version_pins) p
     where s.skill_version_id = ${skillVersionId}::uuid
       and s.extractor_version = ${EXTRACTOR_VERSION}
  `);
  if (rows.length === 0) return [];

  const current = await currentVersions();
  const out: VersionDrift[] = [];

  for (const row of rows) {
    const subject = resolveVersioned(row.tool);
    if (!subject) continue;
    const latest = current.get(subject);
    if (!latest) continue;
    const thing = versionedById(subject);
    if (!thing) continue;

    /*
     * One row per project, keeping the **oldest** pin. A document mentioning Python 3.9 and
     * 3.12 is written for 3.9 at the point it matters, and reporting both would be two rows
     * about one decision.
     */
    const state = compareVersion(row.version, latest.version, thing.precision);
    const behind = stepsBehind(row.version, latest.version, thing.precision);
    const existing = out.find((d) => d.subject === subject);
    if (existing) {
      if ((behind ?? 0) > (existing.stepsBehind ?? 0)) {
        existing.pinned = row.version;
        existing.state = state;
        existing.stepsBehind = behind;
      }
      continue;
    }
    out.push({
      subject,
      label: thing.label,
      pinned: row.version,
      current: latest.version,
      releasedAt: latest.releasedAt,
      state,
      stepsBehind: behind,
    });
  }

  /*
   * Only what is worth saying. One major behind is ordinary and often deliberate; the panel
   * stays a short list of things worth a look rather than a running commentary on twenty
   * projects' release cadence. The full set is still returned to callers that want it — the
   * filter is here so every surface applies the same one.
   */
  return out.filter(
    (d) => d.state === "behind" && (d.stepsBehind ?? 0) >= DRIFT_STEPS_BEFORE_SURFACING,
  );
}

/** Coverage and the headline counts, for the Freshness panel and the CLI. */
export async function versionSummary() {
  const rows = await db
    .select({
      subject: toolVersions.subject,
      currentVersion: toolVersions.currentVersion,
      releasedAt: toolVersions.releasedAt,
      status: toolVersions.status,
      checkedAt: toolVersions.checkedAt,
      consecutiveFailures: toolVersions.consecutiveFailures,
    })
    .from(toolVersions)
    .orderBy(toolVersions.subject);

  const { rows: pinned } = await db.execute<{ documents: number }>(sql`
    select count(distinct s.skill_version_id)::int as documents
      from skill_structures s
     where s.extractor_version = ${EXTRACTOR_VERSION} and s.version_pins <> '[]'::jsonb
  `);

  return {
    tracked: VERSIONED.length,
    checked: rows.length,
    rows,
    /** Documents carrying at least one pin of any name, recognised or not. */
    documentsWithPins: pinned[0]?.documents ?? 0,
  };
}
