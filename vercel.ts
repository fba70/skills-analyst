import type { VercelConfig } from "@vercel/config/v1";

/**
 * Deployment configuration, including the ingest schedule (Doc 2 R1.7).
 *
 * `vercel.ts` rather than `vercel.json`: it is typed, so a malformed cron expression or a
 * misspelled key is a build error instead of a schedule that silently never fires.
 *
 * ## The cadence
 *
 * Twice a day, and the job it is sized for is **freshness, not catch-up**. Initial
 * ingestion runs from a local machine, where there is no function ceiling and a
 * 2,000-skill repository can take the hour it needs. A schedule racing that same queue
 * would duplicate every fetch and contend for the same rows.
 *
 * What the schedule is for is the part nobody remembers to do: R7.4 asks that upstream
 * changes be detected within 24 hours, and `pendingSources` returns sources whose last
 * successful sync is older than that. Two passes a day against a 24-hour staleness window
 * means a due source is picked up within twelve — inside the target, with margin for a
 * pass that fails.
 *
 * It also keeps compute honest. Ten minutes is 144 invocations a day whether or not there
 * is anything to do; this is two, and a pass with nothing due costs one cheap query per
 * stage and returns.
 *
 * ## What is deliberately not scheduled
 *
 * The LLM analyzers (R2.3) and the taxonomy classifier. Both cost money per skill, and a
 * schedule that quietly spends is one nobody can leave switched on. They stay manual —
 * a command or an admin button — until RC.2's per-org spend caps exist to bound them.
 */
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    {
      path: "/api/cron/pipeline",
      // 05:00 and 17:00 UTC — twelve hours apart, inside R7.4's 24-hour window.
      schedule: "0 5,17 * * *",
    },
  ],
};

export default config;
