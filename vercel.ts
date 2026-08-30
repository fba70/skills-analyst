import type { VercelConfig } from "@vercel/config/v1";

/**
 * Deployment configuration, including the ingest schedule (Doc 2 R1.7).
 *
 * `vercel.ts` rather than `vercel.json`: it is typed, so a malformed cron expression or a
 * misspelled key is a build error instead of a schedule that silently never fires.
 *
 * ## The cadence
 *
 * Ten minutes, and the number follows from the arithmetic rather than taste. Each pass
 * takes two sources; 518 sources awaiting a first sync therefore need ~260 passes, which at
 * this cadence is about two days of unattended catch-up. After that the same schedule keeps
 * the corpus inside R7.4's 24-hour freshness target with room to spare, because a pass with
 * nothing to fetch costs one cheap query per stage and returns immediately.
 *
 * Slower would stretch the catch-up into a week. Faster would overlap: a pass can run for
 * several minutes, and two passes fetching the same sources concurrently would duplicate
 * work and race each other's writes.
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
      schedule: "*/10 * * * *",
    },
  ],
};

export default config;
