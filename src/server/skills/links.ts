import "server-only";

import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";

import {
  classifyLink,
  isCheckableUrl,
  isRotten,
  MAX_LINKS_PER_SKILL,
  RECHECK_AFTER_HOURS,
  ROT_THRESHOLD,
  type LinkStatus,
} from "@/lib/freshness";
import { db } from "@/server/db";
import { linkChecks, skills, skillVersions } from "@/server/db/schema";
import { fetchWithDeadline } from "@/server/http/deadline";

/**
 * External link rot (Doc 6 RK.2, plan step E1).
 *
 * ## The only freshness signal nobody has to declare
 *
 * Every other kind of staleness is a judgement expressed as a date — somebody decides a skill
 * should be looked at again, and `review_by` records it. A dead link is a fact: the document
 * points at documentation that has gone, and it is the commonest way a skill quietly stops
 * working. A `reference-pointer` block to a vendor page that moved sends an agent nowhere, and
 * nothing in the pipeline notices.
 *
 * ## Free, and therefore schedulable
 *
 * No model, so the standing rule that nothing costing money is scheduled does not bite. What it
 * does spend is somebody else's bandwidth, which is why the pass is bounded, deduplicated across
 * skills, and never re-checks a URL it looked at recently.
 */

/**
 * Markdown links, bare URLs, and the angle-bracket form. Deliberately generous.
 *
 * The backtick is excluded from the character class rather than stripped afterwards, because it
 * can never appear inside a URL — so a fenced `https://x.dev/a` would otherwise be fetched with
 * the closing backtick attached, and a URL with a stray character 404s. Which is the one verdict
 * this module treats as confident, so the cheap mistake is the expensive one.
 */
const URL_PATTERN = /https?:\/\/[^\s)<>"'`\]]+/g;

/**
 * Every checkable external URL in a document.
 *
 * Extracted from the body text rather than from `skill_blocks`, and that is a real choice: a link
 * in a code fence is still a link an author put there, and block segmentation would exclude the
 * fenced ones. The filter is `isCheckableUrl`, which drops placeholders, private ranges and
 * `example.com` — the things that are syntactically URLs and semantically not.
 */
export function extractLinks(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(URL_PATTERN)) {
    /*
     * Trailing punctuation is part of the sentence, not the URL. `(see https://x.dev/a.)` and
     * `[docs](https://x.dev/a),` both end up with a character that would 404 on its own — and a
     * 404 is precisely the verdict this module treats as confident, so the cheap fix matters.
     *
     * `*` and `_` are stripped in trailing position only: both are legal inside a URL and neither
     * ever ends one, so `*https://x.dev/a*` is emphasis rather than a path.
     */
    const url = match[0].replace(/[.,;:!?*_]+$/, "");
    if (isCheckableUrl(url)) found.add(url);
    if (found.size >= MAX_LINKS_PER_SKILL) break;
  }
  return [...found];
}

export type LinkOutcome = { url: string; status: LinkStatus; statusCode: number | null };

/**
 * Ask a server whether a page is there, as cheaply as politeness allows.
 *
 * `HEAD` first, because it costs the other end a header write and nothing else. A surprising
 * number of servers answer `405` or `501` to it, so a non-2xx that is *not* a definite verdict
 * falls back to a ranged `GET` — one byte, not a page.
 *
 * Both go through `fetchWithDeadline`. That is not optional here: this walks arbitrary
 * third-party hosts, which is exactly the population that includes one which accepts a
 * connection and never answers — the failure that hung two ingestion runs for hours.
 */
export async function checkLink(url: string): Promise<LinkOutcome> {
  const attempt = async (method: "HEAD" | "GET"): Promise<number | null> => {
    try {
      const response = await fetchWithDeadline(url, {
        method,
        redirect: "follow",
        headers: {
          /*
           * Named, with a contact route. A crawler that will not say who it is gets blocked, and
           * a `blocked` verdict is the one this module can conclude least from.
           */
          "user-agent": "SkillsFoundryLinkCheck/1.0 (+https://github.com/skills-foundry)",
          ...(method === "GET" ? { range: "bytes=0-0" } : {}),
        },
      });
      return response.status;
    } catch {
      return null;
    }
  };

  let code = await attempt("HEAD");
  /*
   * A method the server dislikes is not a missing page. Re-asking with GET costs one more round
   * trip and removes the single largest source of false rot.
   */
  if (code === 405 || code === 501 || code === 400) code = await attempt("GET");

  return { url, status: classifyLink(code), statusCode: code };
}

export type CheckReport = {
  versionsChecked: number;
  linksChecked: number;
  rotten: number;
  recovered: number;
  /** Rows dropped because the extraction rules no longer produce that URL. */
  pruned: number;
};

/**
 * Check a bounded slice of the corpus, oldest-checked first.
 *
 * Resumable and incremental in the way every other stage here is: the selector is *what has not
 * been looked at*, so running it twice does half the work twice rather than the same work twice,
 * and it can be called from a schedule or by hand with no coordination.
 */
export type LinkTarget = { skillId: string; versionId: string; orgId: string | null };

/**
 * Documents to look at, in priority order.
 *
 * ## Confirmation first, and the first real pass is what showed why
 *
 * A naive oldest-first selector is correct for coverage and **makes rot unconfirmable**. The first
 * pass over the real corpus found 50 links returning 404 — none reportable, because rot needs two
 * consecutive failures and at 200 documents a pass over 49,000 the second look is 245 passes away.
 * The threshold was unreachable by construction, and nothing in the code said so; it took running
 * it to see.
 *
 * So a document with an outstanding failure jumps the queue after `RECHECK_AFTER_HOURS`. That is a
 * small share of the corpus by definition — only documents that already failed once — so it costs
 * little, and it is the only path by which anything ever becomes reportable.
 *
 * Then never-checked, then oldest, which is the coverage half. Losing that second key would mean a
 * checker that only revisits what it has already seen fail: perfect confirmation, no discovery.
 *
 * Exported so `verify:freshness` can drive the ordering directly. Asserting the SQL exists proves
 * it was written; driving it proves it works, and the bug this fixes was invisible to the first.
 */
export async function nextTargets(limit: number): Promise<LinkTarget[]> {
  return db
    .select({
      skillId: skills.id,
      versionId: skillVersions.id,
      orgId: skills.orgId,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
    .where(
      and(
        eq(skills.status, "indexed"),
        isNull(skills.orgId),
        /*
         * Only documents whose bytes we hold.
         *
         * `metadata_only` and `unresolved` skills are analysed in memory and never mirrored, so
         * their links are unreadable — and the first run showed why that matters: they sorted to
         * the front as never-checked, produced nothing, and **sorted to the front again next
         * pass**, starving the queue behind them. Excluded here rather than marked checked,
         * because a row saying "looked, found nothing" would be a claim about a document we
         * cannot open.
         */
        eq(skillVersions.contentStored, true),
      ),
    )
    .orderBy(
      sql`case when exists (
            select 1 from link_checks lc
             where lc.skill_version_id = ${skillVersions.id}
               and lc.consecutive_failures > 0
               and lc.consecutive_failures < ${ROT_THRESHOLD}
               and lc.checked_at < now() - make_interval(hours => ${RECHECK_AFTER_HOURS})
          ) then 0 else 1 end asc`,
      sql`(
        select max(lc.checked_at) from link_checks lc
         where lc.skill_version_id = ${skillVersions.id}
      ) asc nulls first`,
    )
    .limit(limit);
}

/**
 * Check a bounded slice of the corpus.
 *
 * Resumable and incremental in the way every other stage here is: the selector is *what most needs
 * looking at*, so running it twice does more work rather than the same work twice, and it can be
 * called from a schedule or by hand with no coordination.
 */
export async function checkLinks(options: { limit?: number } = {}): Promise<CheckReport> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));
  const targets = await nextTargets(limit);

  const report: CheckReport = {
    versionsChecked: 0,
    linksChecked: 0,
    rotten: 0,
    recovered: 0,
    pruned: 0,
  };

  /*
   * One cache per pass. The corpus links to the same handful of vendor docs thousands of times,
   * and asking `docs.anthropic.com` four hundred times in one run is the behaviour that gets a
   * crawler blocked — which would then be recorded as `blocked` on four hundred skills.
   */
  const seen = new Map<string, LinkOutcome>();

  for (const target of targets) {
    const body = await bodyFor(target.versionId);
    if (body === null) continue;

    const urls = extractLinks(body);
    report.versionsChecked += 1;

    /*
     * Drop rows for URLs this document no longer contributes.
     *
     * A version is immutable, so its link set only changes when the *extraction rules* do — and
     * they just did: widening the placeholder filter to cover `api.example.com` and dotless hosts
     * orphaned rows that would otherwise sit in the panel as `unreachable` for ever, describing
     * links the checker has stopped believing in. Pruning here means a rule change corrects itself
     * on the next pass instead of needing a migration or a memory.
     */
    report.pruned += await prune(target.versionId, urls);
    if (urls.length === 0) {
      /*
       * A document with no links still needs a timestamp, or the selector returns it first on
       * every pass forever and the queue never advances past it. Recorded as a sentinel row
       * rather than a column on the version, because the version is the corpus's and this is
       * bookkeeping for a check that may be re-run under different rules.
       */
      await touchEmpty(target.skillId, target.versionId, target.orgId);
      continue;
    }

    for (const url of urls) {
      const outcome = seen.get(url) ?? (await checkLink(url));
      seen.set(url, outcome);
      report.linksChecked += 1;

      const result = await record(target.skillId, target.versionId, target.orgId, outcome);
      if (result === "rotten") report.rotten += 1;
      if (result === "recovered") report.recovered += 1;
    }
  }

  return report;
}

/**
 * Upsert one link's state, and report whether that crossed a line.
 *
 * The failure counter is the whole state machine: incremented on anything that is not `ok`, and
 * **reset to zero on success**, so a link that recovered stops accusing immediately rather than
 * decaying out of the panel. Only `broken` counts towards rot — see `classifyLink`.
 */
async function record(
  skillId: string,
  versionId: string,
  orgId: string | null,
  outcome: LinkOutcome,
): Promise<"rotten" | "recovered" | null> {
  const [before] = await db
    .select({
      status: linkChecks.status,
      failures: linkChecks.consecutiveFailures,
    })
    .from(linkChecks)
    .where(and(eq(linkChecks.skillVersionId, versionId), eq(linkChecks.url, outcome.url)))
    .limit(1);

  const wasRotten = before ? isRotten(before.status as LinkStatus, before.failures) : false;
  const failures = outcome.status === "ok" ? 0 : (before?.failures ?? 0) + 1;
  const nowRotten = isRotten(outcome.status, failures);

  await db
    .insert(linkChecks)
    .values({
      orgId,
      skillId,
      skillVersionId: versionId,
      url: outcome.url,
      status: outcome.status,
      statusCode: outcome.statusCode,
      consecutiveFailures: failures,
      firstFailedAt: failures === 1 ? new Date() : undefined,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [linkChecks.skillVersionId, linkChecks.url],
      set: {
        status: outcome.status,
        statusCode: outcome.statusCode,
        consecutiveFailures: failures,
        /* Cleared on recovery, so a link that broke twice years apart is not one long outage. */
        firstFailedAt: failures === 0 ? null : (before?.failures ?? 0) === 0 ? new Date() : undefined,
        checkedAt: new Date(),
      },
    });

  if (nowRotten && !wasRotten) return "rotten";
  if (wasRotten && !nowRotten) return "recovered";
  return null;
}

/**
 * Remove stored links this document no longer yields.
 *
 * The empty-string sentinel is kept deliberately: it is the row that records *this version was
 * looked at*, and deleting it would send the version back to the front of the queue every pass.
 */
async function prune(versionId: string, keep: string[]): Promise<number> {
  const result = await db
    .delete(linkChecks)
    .where(
      and(
        eq(linkChecks.skillVersionId, versionId),
        sql`${linkChecks.url} <> ''`,
        /*
         * `notInArray`, not `<> all(${keep})` in a template.
         *
         * Drizzle renders a JS array inside a `sql` template as a **row constructor** — `($2)` —
         * which is what `in` takes and is not an array, so Postgres answers *malformed array
         * literal*. CLAUDE.md records the identical trap from the lifecycle branch, where it read
         * *op ANY/ALL (array) requires array on right side*; same cause, different message, and
         * it shipped again because the template form reads so naturally.
         */
        keep.length > 0 ? notInArray(linkChecks.url, keep) : sql`true`,
      ),
    );
  return result.rowCount ?? 0;
}

/** A version with no links: one sentinel row so the queue advances past it. */
async function touchEmpty(skillId: string, versionId: string, orgId: string | null) {
  await db
    .insert(linkChecks)
    .values({
      orgId,
      skillId,
      skillVersionId: versionId,
      url: "",
      status: "ok",
      consecutiveFailures: 0,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [linkChecks.skillVersionId, linkChecks.url],
      set: { checkedAt: new Date() },
    });
}

async function bodyFor(versionId: string): Promise<string | null> {
  const [row] = await db
    .select({
      contentStored: skillVersions.contentStored,
      contentHash: skillVersions.contentHash,
      provenance: skillVersions.provenance,
    })
    .from(skillVersions)
    .where(eq(skillVersions.id, versionId))
    .limit(1);
  if (!row?.contentStored) return null;

  try {
    const { loadBundle } = await import("@/server/validation/bundle-loader");
    const bundle = await loadBundle({
      contentStored: row.contentStored,
      contentHash: row.contentHash,
      tier: "public",
      provenance: row.provenance as never,
    });
    return bundle.files.map((file) => file.content.toString("utf8")).join("\n");
  } catch {
    /*
     * A bundle we cannot read is not a link problem. Swallowed and skipped rather than recorded,
     * because a storage blip written as `unreachable` on every URL in a document would look
     * exactly like the site going down.
     */
    return null;
  }
}

export type RottenLink = {
  slug: string;
  name: string;
  url: string;
  statusCode: number | null;
  failures: number;
  firstFailedAt: Date | null;
};

/** Links confidently gone, for the panel. Rotten only — see the classification. */
export async function rottenLinks(limit = 50): Promise<RottenLink[]> {
  const rows = await db
    .select({
      slug: skills.slug,
      name: skills.name,
      url: linkChecks.url,
      statusCode: linkChecks.statusCode,
      failures: linkChecks.consecutiveFailures,
      firstFailedAt: linkChecks.firstFailedAt,
    })
    .from(linkChecks)
    .innerJoin(skills, eq(skills.id, linkChecks.skillId))
    .where(
      and(
        eq(linkChecks.status, "broken"),
        sql`${linkChecks.consecutiveFailures} >= 2`,
        /* Only where the check still describes the served document. */
        eq(linkChecks.skillVersionId, skills.currentVersionId),
      ),
    )
    .orderBy(asc(linkChecks.firstFailedAt))
    .limit(limit);
  return rows;
}

export type LinkCheckSummary = {
  versionsChecked: number;
  links: number;
  broken: number;
  blocked: number;
  unreachable: number;
  /** Oldest check in the table, as a real `Date`. See the note in the body. */
  oldest: Date | null;
  servable: number;
};

/** Coverage, so the panel can say how much of the corpus this is a statement about. */
export async function linkCheckSummary(): Promise<LinkCheckSummary> {
  const [row] = await db
    .select({
      versionsChecked: sql<number>`count(distinct ${linkChecks.skillVersionId})::int`,
      links: sql<number>`count(*) filter (where ${linkChecks.url} <> '')::int`,
      broken: sql<number>`count(*) filter (where ${linkChecks.status} = 'broken' and ${linkChecks.consecutiveFailures} >= 2)::int`,
      blocked: sql<number>`count(*) filter (where ${linkChecks.status} = 'blocked')::int`,
      unreachable: sql<number>`count(*) filter (where ${linkChecks.status} = 'unreachable')::int`,
      /*
       * Typed `string | null`, not `Date | null`.
       *
       * `sql<T>` is a **claim about** the value, not a conversion of it: drizzle applies no
       * parser to a raw expression, so an aggregate over a `timestamptz` arrives as the driver's
       * string and `sql<Date>` would be a lie the compiler happily accepts. Annotating it as a
       * Date is how the CLI came to call `.toISOString()` on a string.
       *
       * Same shape as reading `usage.inputTokens` from `embedMany`, which returns `undefined` and
       * meters a whole backfill as free. A type that describes what you wanted rather than what
       * arrives is worse than no type.
       */
      oldest: sql<string | null>`min(${linkChecks.checkedAt})`,
    })
    .from(linkChecks);

  const [corpus] = await db
    .select({ servable: sql<number>`count(*)::int` })
    .from(skills)
    .where(and(eq(skills.status, "indexed"), isNull(skills.orgId)));

  /* Converted once, at the boundary, so no caller has to know what the driver hands back. */
  return {
    ...row,
    oldest: row?.oldest ? new Date(row.oldest) : null,
    servable: corpus?.servable ?? 0,
  };
}
