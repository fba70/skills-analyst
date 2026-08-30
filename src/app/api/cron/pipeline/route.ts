import { runPipeline } from "@/server/pipeline/run";

/**
 * The scheduled ingest pass (Doc 2 R1.7).
 *
 * Vercel Cron calls this on a timer; it runs one bounded pipeline pass and returns what it
 * did. That is the whole of the scheduler — there is no queue, no worker, no state machine.
 * Every stage is already resumable and idempotent, so "run a slice periodically" is a
 * complete implementation rather than a placeholder for one.
 *
 * ## Why this exists
 *
 * Everything was hand-run: a command, a button, or a shell loop babysat by whoever was
 * around. R7.4 asks that upstream changes be detected within 24 hours, which no human
 * remembers to do, and 518 sources at five per pass is a hundred passes nobody is going to
 * sit through. The gap was visible for a while as a spec item; it became urgent when the
 * shell loops kept being killed mid-pass and the corpus simply stopped growing.
 *
 * ## Boundaries this respects
 *
 * The route touches no database directly — it calls `runPipeline`, which is `server-only`
 * and where the queries live. That keeps the repo's rule intact: route handlers get no
 * database, and this one has none.
 *
 * It is also **not** the place for anything that costs money. The LLM analyzers (R2.3) and
 * the taxonomy classifier stay opt-in and manual. A scheduler that quietly spends is a
 * scheduler nobody can leave switched on.
 */

/**
 * Fluid Compute allows well beyond the 300 s default, and a pass that fetches five
 * repositories can genuinely need it. The sync stage carries its own 8-minute budget, so
 * this is a backstop for the whole pass rather than the thing that bounds it.
 */
export const maxDuration = 800;

/** Never cached: every call must actually do the work. */
export const dynamic = "force-dynamic";

/**
 * Sources per scheduled pass.
 *
 * At two passes a day this is the freshness budget, not a catch-up rate: twelve sources
 * refreshed daily, chosen oldest-first, which is what R7.4's 24-hour window needs once
 * initial ingestion is done.
 *
 * Still well inside the function ceiling, because `MAX_SKILLS_PER_SOURCE` means no single
 * source can run away with the budget — that is the guard that makes a larger number safe
 * here, and its absence is what made the previous pass time out.
 */
const SOURCES_PER_PASS = 6;

/**
 * A scheduled pass will not start a source larger than this.
 *
 * Measured, not guessed: the first live cron run hit `FUNCTION_INVOCATION_TIMEOUT` after
 * the full 800 seconds on a single repository, and would have retried the same one every
 * ten minutes forever, because a timed-out source is never marked synced.
 *
 * A source must be fetched completely — a partial enumeration would make R1.5 tombstone
 * everything it did not reach — so the only safe bound is deciding before the fetch begins.
 * Anything larger is held for review and synced deliberately with `pnpm sync <url>`, which
 * has no ceiling. 120 skills is comfortably inside 13 minutes at the fetch concurrency the
 * ingest policy allows.
 */
const MAX_SKILLS_PER_SOURCE = 120;

/**
 * Confirms the caller is Vercel Cron and not the open internet.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when the variable is set. Without the
 * check this route is an unauthenticated endpoint that anyone can use to make us fetch
 * hundreds of repositories on demand — a denial-of-wallet against our own GitHub budget.
 *
 * Absent `CRON_SECRET` the route refuses rather than running openly. Failing closed on a
 * missing secret is the only safe default: the alternative is a deployment that is quietly
 * unprotected exactly when someone forgot to configure it.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json(
      {
        error: "unauthorized",
        message:
          "This endpoint is called by the scheduler. Set CRON_SECRET and send it as a bearer token.",
      },
      { status: 401 },
    );
  }

  const startedAt = Date.now();

  try {
    const report = await runPipeline({
      trigger: "cron",
      sources: SOURCES_PER_PASS,
      maxSkillsPerSource: MAX_SKILLS_PER_SOURCE,
      // Leave room for the stages behind sync inside the function's ceiling.
      syncBudgetMs: 6 * 60_000,
    });

    return Response.json({
      ok: report.ok,
      elapsedMs: Date.now() - startedAt,
      stages: report.stages,
    });
  } catch (error) {
    // A 500 is what makes a failing schedule visible in Vercel's cron log. Swallowing it
    // would leave a job that reports success forever while doing nothing.
    return Response.json(
      {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: (error as Error).message.slice(0, 500),
      },
      { status: 500 },
    );
  }
}
