import "dotenv/config";

import { runPipeline } from "../src/server/pipeline/run";

/**
 * The ingest pipeline, end to end (sync → validate → fingerprint → signatures → cluster).
 *
 *   pnpm pipeline                    # one bounded pass of every stage
 *   pnpm pipeline --loop 40          # repeat until nothing is left to do
 *   pnpm pipeline --skip-sync        # catch the derived stages up without fetching
 *   pnpm pipeline --sources 3 --validate 200
 *
 * This exists because running the stages separately let the derived ones fall behind: with
 * the corpus growing every pass, fingerprints drifted 1,566 behind and dedup signatures
 * 2,240. Both gaps are invisible — they look exactly like a smaller corpus — and both stall
 * archetype mining, which reads fingerprints and only sees canonical skills.
 */

const args = process.argv.slice(2);
const num = (flag: string, fallback?: number) => {
  const i = args.indexOf(`--${flag}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/**
 * `pnpm pipeline --status` — "is it stuck?", answered in one line.
 *
 * The question that cost hours three times over, now cheap enough to ask casually.
 */
if (args.includes("--status")) {
  const { readHeartbeat } = await import("../src/server/pipeline/heartbeat");
  const hb = await readHeartbeat();
  if (!hb) {
    console.info("\nNo pipeline is running (no heartbeat).\n");
  } else {
    const pass = hb.passStartedAt
      ? `${Math.round((Date.now() - hb.passStartedAt.getTime()) / 60000)}m into this pass`
      : "pass start unknown";
    console.info(
      `\n${hb.stale ? "STALLED?" : "running "}  ${hb.stage ?? "?"}  ${hb.detail ?? ""}\n` +
        `  last progress   ${hb.secondsSinceBeat}s ago${hb.stale ? "  ← nothing for over 2 minutes" : ""}\n` +
        `  ${pass} · pid ${hb.pid ?? "?"}\n`,
    );
  }
  process.exit(hb?.stale ? 1 : 0);
}

const passes = num("loop", 1) ?? 1;
const skipSync = args.includes("--skip-sync");

for (let pass = 1; pass <= passes; pass += 1) {
  if (passes > 1) console.info(`\n━━ pass ${pass}/${passes}`);

  const report = await runPipeline({
    trigger: "cli",
    sources: num("sources"),
    validate: num("validate"),
    structures: num("structures"),
    signatures: num("signatures"),
    pairs: num("pairs"),
    skipSync,
    onProgress: (m) => console.info(m),
  });

  /**
   * Stop early once every stage reports it had nothing to do.
   *
   * Each stage returns a sentence starting "no …" or "nothing …" when its queue is empty,
   * or a count when it worked. Looping past an all-idle pass is load on the database and
   * the GitHub API for no result.
   */
  const idle = report.stages.every((s) => s.ok && /^(no |nothing )/.test(s.detail));
  if (passes > 1 && idle) {
    console.info("\nnothing left to do");
    break;
  }
}

console.info("");
process.exit(0);
