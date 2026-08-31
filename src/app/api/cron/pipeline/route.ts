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
 * The knobs that used to live here are now in `platform_settings`.
 *
 * Sources per pass and the per-source skill ceiling were both constants in this file,
 * measured against the function ceiling after a pass timed out at 800 seconds on a single
 * repository. They kept their values and moved into the settings table with their defaults
 * intact — see `settings/schedule.ts`, which is now where the reasoning lives.
 *
 * The move is Doc 3's "cadence is data, not deploys": tuning ingestion against a live
 * corpus through a redeploy is too slow to learn anything, and switching it *off* through a
 * redeploy is worse than that.
 */

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
    const { getSchedule, stageDue } = await import("@/server/settings/schedule");
    const schedule = await getSchedule();

    /**
     * The cron fires on a fixed expression; the settings decide whether it does anything.
     *
     * Nothing in a database can change `vercel.ts`, so a tick that arrives before a stage
     * is due returns having done nothing. That makes the settings a throttle and an off
     * switch, never an accelerator — and the response says which, because a scheduler that
     * silently no-ops is indistinguishable from one that is broken.
     */
    const [pipelineDue, archetypesDue] = await Promise.all([
      stageDue("pipeline", schedule),
      stageDue("archetypes", schedule),
    ]);

    const skipped: Record<string, string> = {};
    let report: Awaited<ReturnType<typeof runPipeline>> | null = null;

    if (pipelineDue.due) {
      report = await runPipeline({
        trigger: "cron",
        sources: schedule.pipeline.sourcesPerPass,
        maxSkillsPerSource: schedule.pipeline.maxSkillsPerSource,
        // Leave room for the stages behind sync inside the function's ceiling.
        syncBudgetMs: 6 * 60_000,
      });
    } else {
      skipped.pipeline = pipelineDue.reason;
    }

    /**
     * Archetype refresh, which G2 asks to happen at least weekly.
     *
     * Free — mining reads stored fingerprints and calls no model — but it rewrites the
     * guidance the builder scaffolds from, which is why it ships switched off and why it
     * runs *after* the pipeline: a refresh should see the skills this pass just ingested.
     */
    let archetypes: string | null = null;
    if (archetypesDue.due) {
      const { mineAll } = await import("@/server/analytics/archetype-run");
      const results = await mineAll();
      const stored = results.filter((r) => r.stored);
      archetypes = `${stored.length} of ${results.length} categories re-mined`;
    } else {
      skipped.archetypes = archetypesDue.reason;
    }

    return Response.json({
      ok: report?.ok ?? true,
      elapsedMs: Date.now() - startedAt,
      stages: report?.stages ?? [],
      archetypes,
      skipped,
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
