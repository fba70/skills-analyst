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
 * Lower than the manual default of five. A cron pass has a hard ceiling it cannot negotiate
 * with, and being cut off mid-stage loses the stages behind it — so the scheduled path
 * trades throughput for reliably finishing. At a ten-minute cadence this still clears
 * roughly 290 sources a day.
 */
const SOURCES_PER_PASS = 2;

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
