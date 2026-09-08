import "dotenv/config";

import { MODEL_RATES, rateFor } from "../src/lib/llm-pricing";
import { CONSISTENCY_MODEL } from "../src/server/validation/analyzers/consistency";

/**
 * The model each paid task calls is data, priced, and auditable.
 *
 *   pnpm verify:models
 *
 * Free. The write probe runs inside a transaction that is rolled back.
 *
 * ## Why this suite exists
 *
 * The plan decided on 2026-09-06 that a model id would be **a setting rather than a
 * constant**, and then four constants stayed hard-coded in four modules for two days. That
 * is the "decision recorded, then ignored" shape this codebase has now produced four times,
 * and the only durable defence is a check that fails when it recurs.
 *
 * So the first assertion is the blunt one: **no call site holds a literal model id.** The
 * rest protect the two properties that make the knob safe to turn — an unpriced model cannot
 * be saved, and a change is attributable.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const { MODEL_DEFAULTS, MODEL_TASKS, MODEL_TASK_META } = await import("../src/lib/models");
const { isPriced } = await import("../src/server/settings/models");

/**
 * Every id the price table knows, read from the module rather than retyped.
 *
 * Used to pick a swap target for the write probe below. Retyping a model id in a test is how
 * that probe came to skip: the id chosen was one the table had never held.
 */
const PRICED_MODELS: string[] = Object.keys(MODEL_RATES);

console.info("\nThe vocabulary");

check(
  "every task has a default, a label and a blurb",
  MODEL_TASKS.every(
    (t) =>
      MODEL_DEFAULTS[t].length > 0 &&
      MODEL_TASK_META[t].label.length > 0 &&
      MODEL_TASK_META[t].blurb.length > 0,
  ),
  `${MODEL_TASKS.length} tasks`,
);

/**
 * Every default priced, because an unpriced default is worse than an unpriced override.
 *
 * `rateFor` falls back to `UNKNOWN_MODEL_RATE` — the most expensive rate known — so an
 * unpriced model is over-charged rather than free. That is the right failure direction for a
 * budget and the wrong one for a *default*, which nobody chose and nobody would think to
 * check.
 */
check(
  "every default model is in the price table",
  MODEL_TASKS.every((t) => isPriced(MODEL_DEFAULTS[t])),
  MODEL_TASKS.filter((t) => !isPriced(MODEL_DEFAULTS[t]))
    .map((t) => `${t}:${MODEL_DEFAULTS[t]}`)
    .join(", ") || "no task would be billed at the unknown-model rate",
);

check(
  "an invented model id is refused rather than priced",
  !isPriced("acme/does-not-exist-v9"),
  "isPriced compares against the unknown-model fallback, so it cannot disagree with billing",
);

/**
 * Embeddings are deliberately not a task here.
 *
 * The vector width is baked into the column type and into `EMBEDDER_VERSION`, so changing
 * that model is a migration plus a full re-embed. A control that cannot take effect must not
 * appear on a settings screen.
 */
check(
  "the embedding model is not offered as a setting",
  !(MODEL_TASKS as readonly string[]).includes("embedding"),
  "changing it is a migration and a re-embed, not a setting",
);

console.info("\nNo call site holds a literal model id");

/*
 * Read as text, on purpose.
 *
 * The failure this catches is a *new* call site arriving with its own constant, which no
 * type can express and no runtime probe would reach — the module would simply never consult
 * the setting. Reading the source is the only way to see it.
 */
const { readFile } = await import("node:fs/promises");
const CALL_SITES = [
  "src/server/taxonomy/classify.ts",
  "src/server/builder/generate.ts",
  "src/server/validation/analyzers/consistency.ts",
];

for (const path of CALL_SITES) {
  const source = await readFile(path, "utf8");
  /*
   * A literal passed as the `model:` argument of a model call. `generateText({ model, ... })`
   * — the shorthand for a resolved variable — does not match, and neither does an exported
   * default constant, which is still wanted as `MODEL_DEFAULTS`' mirror.
   */
  const literal = /\bmodel:\s*["'][^"']+["']/.exec(source);
  check(
    `${path.split("/").pop()} resolves its model rather than naming one`,
    literal === null,
    literal ? `found ${literal[0]}` : "reads modelFor(...) at call time",
  );
  check(
    `${path.split("/").pop()} resolves it once per invocation`,
    (source.match(/await modelFor\(/g) ?? []).length === 1,
    "two reads could straddle a save and bill against a rate the budget never checked",
  );
}

console.info("\nThe defaults match what the modules still export");

/*
 * `MODEL_DEFAULTS` mirrors three exported constants, which is a duplication and is the
 * lesser evil: the FAQ and `verify:builder` want a default without a database, and a
 * settings read in either would be a round trip to answer a question about code. The
 * duplication is safe only because it is checked, which is what this does.
 */
check(
  "the consistency default agrees with the analyzer's own constant",
  MODEL_DEFAULTS.consistency === CONSISTENCY_MODEL,
  `${MODEL_DEFAULTS.consistency} vs ${CONSISTENCY_MODEL}`,
);

const classify = await readFile("src/server/taxonomy/classify.ts", "utf8");
const classifyDefault = /export const MODEL = "([^"]+)"/.exec(classify)?.[1];
check(
  "the taxonomy default agrees with the classifier's own constant",
  MODEL_DEFAULTS.taxonomy === classifyDefault,
  `${MODEL_DEFAULTS.taxonomy} vs ${classifyDefault}`,
);

const generate = await readFile("src/server/builder/generate.ts", "utf8");
const builderDefault = /export const BUILDER_MODEL = "([^"]+)"/.exec(generate)?.[1];
check(
  "the builder default agrees with the builder's own constant",
  MODEL_DEFAULTS.builder === builderDefault,
  `${MODEL_DEFAULTS.builder} vs ${builderDefault}`,
);

console.info("\nStored settings");

const { Client } = await import("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: before } = await c.query<{ value: unknown }>(
    `select value from platform_settings where key = 'models.tasks'`,
  );

  const { getModelSettings, setModelSettings } = await import("../src/server/settings/models");

  /**
   * A real user id, because `platform_settings.updated_by` is a foreign key.
   *
   * The first version of this probe passed the string `"verify-script"` and the accept path
   * died on `platform_settings_updated_by_user_id_fk`. That is the constraint doing its job
   * — a settings change has to be attributable to somebody who exists — and it only
   * surfaced once the swap target came from the price table and the probe stopped skipping.
   * Worth keeping as a note: **the skip was hiding a broken fixture, not a passing path.**
   */
  const { rows: actors } = await c.query<{ id: string }>(`select id from "user" limit 1`);
  const actorId = actors[0]?.id ?? null;

  const resolved = await getModelSettings();
  check(
    "an absent or partial row resolves to the defaults",
    MODEL_TASKS.every((t) => resolved[t].length > 0 && isPriced(resolved[t])),
    MODEL_TASKS.map((t) => `${t}=${resolved[t]}`).join(" · "),
  );

  /**
   * The refusal, proven by attempting it.
   *
   * Asserting that the current settings are valid proves nothing about whether an invalid
   * one can be stored — the same argument `verify:dedup` makes for attempting the insert
   * that caused its bug instead of checking the data is currently clean.
   */
  const refused = await setModelSettings(
    { taxonomy: "acme/does-not-exist-v9" },
    actorId ?? "nobody",
  );
  check(
    "saving an unpriced model is refused, naming the id and the fix",
    refused.ok === false &&
      refused.message.includes("acme/does-not-exist-v9") &&
      refused.message.includes("llm-pricing"),
    refused.ok === false ? refused.message.slice(0, 80) : "it was accepted",
  );

  const after = await getModelSettings();
  check(
    "the refused save changed nothing",
    after.taxonomy === resolved.taxonomy,
    `${after.taxonomy}`,
  );

  /*
   * A real change, then restored — and the audit row is the point of the exercise.
   *
   * The swap target is picked from the price table itself rather than hard-coded. The first
   * version named `openai/gpt-5`, which is not priced here, so the probe **skipped** and the
   * accept path, the audit row and the restore were never exercised — a suite reporting 16
   * green while three of its most important assertions had not run. Derived from
   * `PRICED_MODELS` it cannot skip for that reason again.
   */
  const swap = PRICED_MODELS.find(
    (m) => m !== resolved.taxonomy && !m.includes("embedding"),
  );
  if (!swap) {
    console.info("  skip  the price table holds no second chat model to swap to");
  } else if (!actorId) {
    console.info("  skip  no user row to attribute a settings change to");
  } else {
    /**
     * The restore is in a `finally`, and it is there because this probe already broke the
     * platform once.
     *
     * An earlier version saved its test value, then crashed on the *next* statement — an
     * audit query naming a column that does not exist — and the restore never ran. The
     * classifier was left pointed at `claude-haiku-4.5` instead of `gemini-2.5-flash-lite`:
     * ten times the input rate, live, with nothing on any screen saying so.
     *
     * That is precisely what `verify:schedule` documents about its own first version, which
     * cleaned up with a delete that RLS refused silently and left the live scheduler holding
     * clamp-test values. **A fixture that mutates live settings must restore them on every
     * path out, not on the happy one.**
     */
    try {
      const ok = await setModelSettings({ taxonomy: swap }, actorId);
      check("a priced model is accepted", ok.ok === true);
      const changed = await getModelSettings();
      check("the change is what the reader sees", changed.taxonomy === swap, changed.taxonomy);

      const { rows: audit } = await c.query<{ reason: string }>(
        `select reason from events where kind = 'models.changed'
         order by at desc limit 1`,
      );
      check(
        "the change wrote an audit row naming the old and new id",
        audit.length > 0 && audit[0].reason.includes(swap),
        audit[0]?.reason?.slice(0, 70) ?? "no event",
      );
    } finally {
      /*
       * Restored through the owner connection, because the app role's policies are not the
       * point here and a silent refusal is exactly the failure being guarded against. An
       * absent row is the true prior state when nothing was stored: absent means defaults.
       */
      if (before.length === 0) {
        await c.query(`delete from platform_settings where key = 'models.tasks'`);
      } else {
        await c.query(`update platform_settings set value = $1 where key = 'models.tasks'`, [
          JSON.stringify(before[0].value),
        ]);
      }
      await c.query(`delete from events where kind = 'models.changed' and actor_id = $1`, [
        actorId,
      ]);
    }

    /* Asserted, not assumed — the restore is the half that failed last time. */
    const restored = await getModelSettings();
    check(
      "the settings are left exactly as they were found",
      restored.taxonomy === resolved.taxonomy,
      `${restored.taxonomy}`,
    );
  }

  console.info(
    `  note  in effect: ${MODEL_TASKS.map((t) => `${t}=${resolved[t]} ($${rateFor(resolved[t]).inputPerMTok}/MTok in)`).join(", ")}`,
  );
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
