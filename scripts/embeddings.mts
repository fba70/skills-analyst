import "dotenv/config";

import { EMBEDDING_MODEL } from "../src/server/analytics/embeddings";
import {
  embedCorpus,
  embeddingSummary,
  similarToText,
} from "../src/server/analytics/embeddings-run";
import { rateFor } from "../src/lib/llm-pricing";

/**
 * Corpus embeddings — the pgvector backfill and a similarity probe.
 *
 *   pnpm embeddings --status
 *   pnpm embeddings --sample 100          # COSTS MONEY, tiny; proves the path
 *   pnpm embeddings --backfill 5000       # COSTS MONEY; bounded, resumable, re-runnable
 *   pnpm embeddings --similar "review a terraform plan"   # COSTS MONEY (one embed)
 *
 * ## Why the flags are split like this
 *
 * `--sample` and `--backfill` call the same function with different limits, and the only
 * reason both exist is to make the cheap one obvious. Every other paid command here follows
 * the pattern (`taxonomy --sample`, `validate --consistency`): a small opt-in run first,
 * because a command that spends money on its default invocation is one nobody can leave in a
 * script.
 *
 * The whole corpus costs roughly **eight cents** at $0.02 per million input tokens — measured
 * at ~84 tokens a skill over the first 5,020, not estimated — so the caution is about habit
 * rather than about this bill. The habit is what stopped a real mistake: the table that
 * prices this model was missing an entry, and the unknown-model fallback would have charged
 * the backfill at 250 times its true rate.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  const parsed = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (flag: string) => {
  const i = args.indexOf(`--${flag}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

const usd = (tokens: number) => (tokens / 1_000_000) * rateFor(EMBEDDING_MODEL).inputPerMTok;

async function status() {
  const { totals, eligible, model, version } = await embeddingSummary();
  const covered = eligible > 0 ? (totals.embedded / eligible) * 100 : 0;

  console.info("\nCorpus embeddings");
  console.info(`  model              ${model}`);
  console.info(`  embedder version   ${version}`);
  console.info(`  embedded           ${totals.embedded} of ${eligible} eligible (${covered.toFixed(1)}%)`);
  console.info(`  rows, all versions ${totals.allVersions}`);
  console.info(`  tokens charged     ${totals.tokens.toLocaleString()}  ≈ $${usd(totals.tokens).toFixed(4)}`);

  const remaining = Math.max(0, eligible - totals.embedded);
  if (remaining > 0) {
    /**
     * Projected from what this corpus actually charged, not from a constant.
     *
     * The constant was 60 tokens a skill and the measured average is ~84 — a 40% understate,
     * on the one line an operator reads to decide whether to run the thing. Cheap to get
     * right: the tokens are already in the table. `PRIOR` is only used before the first run,
     * and the output says which of the two it is rather than presenting both as the same
     * kind of number.
     */
    const PRIOR = 84;
    const measured = totals.embedded > 0 ? totals.tokens / totals.embedded : null;
    const perSkill = measured ?? PRIOR;
    console.info(
      `\n  ${remaining} left ≈ $${usd(remaining * perSkill).toFixed(4)} at ` +
        (measured
          ? `${perSkill.toFixed(0)} tokens each, measured over the ${totals.embedded} already done`
          : `an assumed ${PRIOR} tokens each — nothing measured yet`) +
        `\n  pnpm embeddings --backfill 5000   (repeat until remaining is 0)`,
    );
  }
  console.info("");
}

if (args.includes("--status") || args.length === 0) {
  await status();
  process.exit(0);
}

const similar = text("similar");
if (similar) {
  const hits = await similarToText(similar, { limit: value("limit") ?? 10 });
  console.info(`\nNearest skills to: ${similar}\n`);
  if (hits.length === 0) {
    console.info("  nothing — has the backfill run? pnpm embeddings --status\n");
    process.exit(0);
  }
  for (const hit of hits) {
    console.info(`  ${hit.similarity.toFixed(3)}  ${hit.name}`);
    console.info(`         /skills/${hit.slug}`);
    if (hit.summary) console.info(`         ${hit.summary.replace(/\s+/g, " ").slice(0, 96)}`);
  }
  console.info("");
  process.exit(0);
}

const sample = value("sample");
const backfill = value("backfill");
if (sample !== undefined || backfill !== undefined) {
  const limit = sample ?? backfill ?? 100;
  const report = await embedCorpus({
    limit,
    force: args.includes("--force"),
    batchSize: value("batch"),
    onProgress: (m) => console.info(m),
  });

  console.info(
    `\nembedded ${report.embedded} · unchanged ${report.skippedUnchanged} · ` +
      `failed ${report.failed} · remaining ${report.remaining}`,
  );
  console.info(
    `  ${report.inputTokens.toLocaleString()} tokens ≈ $${usd(report.inputTokens).toFixed(4)}` +
      `  (metered against the platform budget)`,
  );
  await status();
  process.exit(report.failed > 0 ? 1 : 0);
}

await status();
process.exit(0);
