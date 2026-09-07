import "dotenv/config";

import { Client } from "pg";

import { MODEL_RATES, rateFor, UNKNOWN_MODEL_RATE } from "../src/lib/llm-pricing";
import {
  composeInput,
  EMBEDDER_VERSION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  inputHash,
} from "../src/server/analytics/embeddings";

/**
 * The embedding path is priced, versioned and metered before it is ever run.
 *
 *   pnpm verify:embeddings
 *
 * **Free.** It embeds nothing — every check here is about the things that would make a paid
 * run wrong, and all of them are knowable without spending anything.
 *
 * ## What is actually at risk
 *
 * Not the vector arithmetic. The risks are the ones that make a metered run silently
 * incorrect, and each has already happened once in this codebase in another form:
 *
 *   1. **A missing price.** `rateFor` falls back to `UNKNOWN_MODEL_RATE` on purpose, which
 *      is the most expensive rate known. For a 29-million-token backfill that is **$145
 *      against a real $0.58**, and the platform cap would have refused the run a fifth of
 *      the way in — looking like a budget problem rather than a missing table row.
 *   2. **A meter reading the wrong field.** `embedMany` reports `usage.tokens`, not
 *      `usage.inputTokens`. Reading the latter returns undefined and meters the whole run
 *      as free, which is exactly the shape of the `recordUsage` bug that made builder spend
 *      invisible and left RC.2 satisfied on paper only.
 *   3. **A composition change with no version bump.** Vectors from two compositions coexist,
 *      look current, and cannot be compared. The column catches a width change; nothing but
 *      the version string catches this one.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe model is priced, so a backfill is not charged at the unknown rate");

const rate = rateFor(EMBEDDING_MODEL);
check(
  "the embedding model has an explicit price",
  EMBEDDING_MODEL in MODEL_RATES,
  `${EMBEDDING_MODEL} at $${rate.inputPerMTok}/MTok`,
);
/**
 * The specific trap, asserted as a number rather than as a presence.
 *
 * `EMBEDDING_MODEL in MODEL_RATES` would pass with a wrong entry. This compares against the
 * fallback, which is what a missing entry actually costs.
 */
check(
  "it is not being charged at the unknown-model fallback",
  rate.inputPerMTok !== UNKNOWN_MODEL_RATE.inputPerMTok,
  `$${rate.inputPerMTok} vs $${UNKNOWN_MODEL_RATE.inputPerMTok} — a 250× difference on this run`,
);
check(
  "an embedding call is priced with no output cost",
  rate.outputPerMTok === 0,
  "a vector is not billed as output; a non-zero rate here would inflate every row",
);

const corpusTokens = 48_000 * 60;
console.info(
  `  note  ~48,000 skills at ~60 tokens each ≈ $${((corpusTokens / 1_000_000) * rate.inputPerMTok).toFixed(4)}` +
    `  (would be $${((corpusTokens / 1_000_000) * UNKNOWN_MODEL_RATE.inputPerMTok).toFixed(2)} unpriced)`,
);

console.info("\nThe version string pins everything that can change the vectors");

for (const part of [EMBEDDING_MODEL.split("/")[1], String(EMBEDDING_DIMENSIONS)]) {
  check(`the embedder version names "${part}"`, EMBEDDER_VERSION.includes(part), EMBEDDER_VERSION);
}
/**
 * The composition is the half that drifts invisibly, so the version has to name it.
 *
 * A model change fails at the insert (fixed-width column). A width change does too. Only a
 * change to what goes *into* the string can produce vectors that sit beside older ones,
 * look current, and are not comparable — so the fields are listed in the version and
 * asserted here.
 */
check(
  "the embedder version names the composition, not just the model",
  ["name", "summary", "labels"].every((field) => EMBEDDER_VERSION.includes(field)),
  EMBEDDER_VERSION,
);
check(
  "the version does not claim a body window it no longer uses",
  !/\d+k\b/.test(EMBEDDER_VERSION),
  "the body was dropped; a stale version string would misdescribe every stored row",
);

console.info("\nThe composed input");

const composed = composeInput({
  name: "Terraform plan review",
  summary: "Review a terraform plan for destructive changes.  Use when asked to check IaC.",
  labels: ["Review & critique", "DevOps & infrastructure"],
});
check("the name is included", composed.includes("Terraform plan review"));
check("the summary is included", composed.includes("destructive changes"));
check("labels are human words, not slugs", composed.includes("Review & critique"));
check(
  "whitespace in the summary is collapsed",
  !composed.includes("changes.  Use"),
  "so two skills differing only in formatting hash identically and are not paid for twice",
);
check(
  "the body is not embedded",
  !composed.includes("body:"),
  "the consumers all match on the claim; see the note in embeddings.ts",
);

const minimal = composeInput({ name: "Bare", summary: null, labels: [] });
check("a skill with no summary and no labels still composes", minimal.length > 0, minimal);

check(
  "the same input hashes identically",
  inputHash(composed) === inputHash(composed) && inputHash(composed) !== inputHash(minimal),
  "which is what lets a re-run skip a version it already paid for",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pricing checks above are complete");
}

if (connected) {
  const { rows: ext } = await c.query<{ installed: string | null }>(
    `select installed_version as installed from pg_available_extensions where name = 'vector'`,
  );
  const installed = ext[0]?.installed ?? null;

  if (!installed) {
    console.info("  skip  the vector extension is not installed yet — apply the migration");
  } else {
    check("pgvector is installed", true, `version ${installed}`);

    const { rows: dims } = await c.query<{ atttypmod: number }>(
      `select a.atttypmod from pg_attribute a
       join pg_class t on t.oid = a.attrelid
       where t.relname = 'skill_embeddings' and a.attname = 'embedding'`,
    );
    check(
      "the column width matches the model's output width",
      dims[0]?.atttypmod === EMBEDDING_DIMENSIONS,
      `column ${dims[0]?.atttypmod} vs model ${EMBEDDING_DIMENSIONS}`,
    );

    const { rows: idx } = await c.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'skill_embeddings' and indexname = 'skill_embeddings_hnsw_idx'`,
    );
    check(
      "an HNSW index exists with cosine distance",
      Boolean(idx[0]?.indexdef?.includes("hnsw") && idx[0].indexdef.includes("vector_cosine_ops")),
      idx[0]?.indexdef?.slice(0, 90) ?? "absent",
    );

    const { rows: pol } = await c.query<{ n: string }>(
      `select count(*)::text as n from pg_policies where tablename = 'skill_embeddings'`,
    );
    check("the table carries an RLS policy", Number(pol[0].n) > 0, `${pol[0].n}`);

    const { rows: purpose } = await c.query<{ n: string }>(
      `select count(*)::text as n from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'llm_purpose' and e.enumlabel = 'corpus_embedding'`,
    );
    check(
      "the spend ledger can record an embedding purpose",
      purpose[0].n === "1",
      "without it every recordUsage insert would be refused by the enum",
    );

    const { rows: counts } = await c.query<{ n: string; versions: string; tokens: string }>(
      `select count(*)::text as n,
              count(distinct embedder_version)::text as versions,
              coalesce(sum(input_tokens), 0)::text as tokens
       from skill_embeddings`,
    );
    console.info(
      `  note  ${counts[0].n} vectors across ${counts[0].versions} embedder version(s), ` +
        `${Number(counts[0].tokens).toLocaleString()} tokens charged`,
    );

    if (counts[0].n === "0") {
      console.info("  skip  nothing embedded yet — run pnpm embeddings --sample 100");
    } else {
      /**
       * Two populations in one column is the failure the version string exists to prevent,
       * and it is invisible to every other check: the index still answers, the rows still
       * look current, and the distances are meaningless across the boundary.
       */
      const { rows: mixed } = await c.query<{ n: string }>(
        `select count(*)::text as n from (
           select skill_version_id from skill_embeddings
           group by skill_version_id having count(distinct embedder_version) > 1) t`,
      );
      console.info(
        `  note  ${mixed[0].n} version(s) embedded under more than one embedder — ` +
          `expected while a version is being rolled forward, never for comparison`,
      );

      const { rows: charged } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_embeddings where input_tokens = 0`,
      );
      check(
        "every stored vector recorded the tokens it was charged for",
        charged[0].n === "0",
        `${charged[0].n} at zero — a meter reading the wrong usage field looks exactly like this`,
      );

      const { rows: ledger } = await c.query<{ n: string }>(
        `select count(*)::text as n from llm_usage where purpose = 'corpus_embedding'`,
      );
      check(
        "the run appears in the append-only spend ledger",
        Number(ledger[0].n) > 0,
        `${ledger[0].n} ledger row(s) — RC.3 wants the bill reconstructible`,
      );
    }
  }
  await c.end();
}

// ---------------------------------------------------------------------------------------
console.info("\nSimilarity for authors (R3.6)");
// ---------------------------------------------------------------------------------------

/**
 * The property worth protecting here is **honesty about coverage**, not recall.
 *
 * During a backfill, "nothing similar exists" and "nothing comparable has been embedded yet"
 * produce the same short list and support opposite conclusions — and the wrong one makes an
 * author publish a duplicate. So the report carries its own coverage and a `reliable` flag,
 * and this asserts the flag actually tracks the threshold rather than being decoration.
 *
 * The second property is that a question that cannot be answered is not charged for.
 */
{
  const { RELIABLE_COVERAGE, similarToText } = await import(
    "../src/server/analytics/embeddings-run"
  );
  const { embeddingSummary } = await import("../src/server/analytics/embeddings-run");

  check(
    "the reliability threshold is short of 100%",
    RELIABLE_COVERAGE > 50 && RELIABLE_COVERAGE < 100,
    `${RELIABLE_COVERAGE}% — the last few per cent are skills arriving faster than the backfill`,
  );

  const { totals, eligible } = await embeddingSummary();
  const coverage = eligible > 0 ? Math.round((totals.embedded / eligible) * 100) : 0;

  /**
   * Short input is refused before anything is embedded.
   *
   * A three-word purpose embeds to noise and would return six arbitrary neighbours with
   * confident-looking scores, which is worse than refusing — and it would be paid for.
   */
  const tokensBefore = totals.tokens;
  const report = await similarToText("x");
  /**
   * Reproduce the failure, then assert the fix.
   *
   * The first version of this check was `hits.length === 0 || coveragePercent === coverage`,
   * which is trivially true — and it passed while `similarToText("x")` returned **ten**
   * arbitrary neighbours and billed for the embedding. The guard existed only in the builder
   * action, so the CLI had none. A check whose condition cannot fail is not a check.
   */
  check(
    "a query too short to mean anything returns nothing",
    report.hits.length === 0,
    `${report.hits.length} hits — noise has nearest neighbours, and they look confident`,
  );
  const afterShort = await embeddingSummary();
  check(
    "and is refused before it is paid for",
    afterShort.totals.tokens === tokensBefore,
    `${afterShort.totals.tokens - tokensBefore} tokens charged for an unanswerable query`,
  );

  check(
    "the report states the coverage it was computed against",
    report.coveragePercent === coverage,
    `${report.coveragePercent}% vs ${coverage}% measured`,
  );
  check(
    "reliability tracks the threshold rather than being hard-coded",
    report.reliable === coverage >= RELIABLE_COVERAGE,
    `coverage ${coverage}%, reliable=${report.reliable}`,
  );

  if (totals.embedded === 0) {
    check(
      "with an empty index no tokens are spent asking",
      afterShort.totals.tokens === tokensBefore,
      "embedding the question to compare against nothing would bill for an unanswerable query",
    );
  } else {
    console.info(
      `  note  ${coverage}% embedded, so a thin similarity result is` +
        `${report.reliable ? " informative" : " a fact about the index, not the corpus"}`,
    );
  }
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
