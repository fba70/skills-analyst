import "server-only";

import { eq } from "drizzle-orm";

import { rateFor } from "@/lib/llm-pricing";
import {
  MODEL_DEFAULTS,
  MODEL_TASKS,
  type ModelSettings,
  type ModelTask,
} from "@/lib/models";
import { db } from "@/server/db";
import { events, platformSettings } from "@/server/db/schema";

/**
 * Which model each paid task calls (Doc 2 RC.2, and the standing "policy becomes data" note).
 *
 * ## Why this exists, and why it is late
 *
 * The plan's own decision on 2026-09-06 was that *every new model call defaults to
 * `google/gemini-2.5-flash-lite` through the gateway for development and test, with the id
 * held as a setting rather than a constant.* Half of that shipped: the taxonomy classifier
 * moved to Flash-Lite and the cost fell accordingly. The other half did not — four model ids
 * stayed hard-coded in four modules, and the decision was recorded and then not applied.
 *
 * That is the third time this codebase has produced that exact shape (a curator approval the
 * sweep skipped, a re-submission that only re-enabled with config to merge, a pause reason
 * naming the wrong threshold), and it matters more here than it looks. Every remaining step
 * in the plan — Interview mode, Distill, the Eval Lab — is a *new* model call, and each one
 * would otherwise arrive with its own constant. A model choice is exactly the knob you want
 * to change without a redeploy: it is the one that costs money, and the reason to change it
 * at short notice is that a task is spending more than it is worth.
 *
 * ## No migration, deliberately
 *
 * `platform_settings` is a generic key/jsonb table, so this is pure code — the same shape
 * `schedule.ts` and `rate-limits.ts` already take. An absent row means exactly the defaults
 * below, which is what keeps a fresh deployment working with nothing configured.
 *
 * ## The vocabulary lives in `src/lib/models.ts`
 *
 * Not here, because the admin panel is a client component and this module is `server-only`.
 * The build refuses that import, correctly, and the fix is the convention this codebase
 * already has for `dialects.ts`, `quality.ts`, `capabilities.ts` and `block-types.ts`: the
 * closed vocabulary in a leaf module, the database access here, one copy of each.
 *
 * ## An unknown id is refused rather than stored
 *
 * `rateFor` falls back to `UNKNOWN_MODEL_RATE`, the most expensive rate known, so an
 * unpriced model does not go unbilled. But a *typo* saved into settings would silently
 * over-charge every call of that task until somebody noticed the ledger, and the admin who
 * made the typo is the one person who could have caught it immediately. So a save is
 * rejected unless the id is priced — the refusal names the id, which is the actionable
 * thing. Adding a model means adding its rate first, which is the correct order anyway.
 */

const KEY = "models.tasks";

export async function getModelSettings(): Promise<ModelSettings> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, KEY))
    .limit(1);

  const stored = (row?.value ?? {}) as Partial<ModelSettings>;

  /*
   * Merged field by field, and each value re-checked against the price table on the way out.
   *
   * The write path validates, so a stored id was priced when it was saved — but a rate can
   * be removed from `llm-pricing.ts` later, and a task silently pointing at an unpriced
   * model is how a budget stops being a budget. Falling back to the default is the safe
   * direction: it is a model we know the price of.
   */
  const resolved = { ...MODEL_DEFAULTS };
  for (const task of MODEL_TASKS) {
    const candidate = stored[task];
    if (typeof candidate === "string" && candidate.length > 0 && isPriced(candidate)) {
      resolved[task] = candidate;
    }
  }
  return resolved;
}

/** One task's model. The call sites want exactly this and nothing else. */
export async function modelFor(task: ModelTask): Promise<string> {
  return (await getModelSettings())[task];
}

/**
 * Is this id in the price table?
 *
 * Asked by comparing against the unknown-model fallback rather than by reading the table's
 * keys, so this cannot disagree with what billing actually charges. `rateFor` is the
 * function the ledger uses; if it treats an id as unknown, so does this.
 */
export function isPriced(model: string): boolean {
  const rate = rateFor(model);
  const unknown = rateFor("__definitely-not-a-real-model__");
  return rate.inputPerMTok !== unknown.inputPerMTok || rate.outputPerMTok !== unknown.outputPerMTok;
}

export type ModelSaveResult = { ok: true } | { ok: false; message: string };

/**
 * Writes the model choices and records who changed them.
 *
 * The `events` row is the audit trail RC.3 wants and the answer to "why did classification
 * get expensive in March". It names the task, the old id and the new one, because a diff is
 * the only form of that record anybody can act on.
 */
export async function setModelSettings(
  next: Partial<ModelSettings>,
  actorId: string,
): Promise<ModelSaveResult> {
  const current = await getModelSettings();
  const merged = { ...current };

  for (const task of MODEL_TASKS) {
    const candidate = next[task];
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (!isPriced(trimmed)) {
      return {
        ok: false,
        message:
          `"${trimmed}" has no entry in the price table, so its calls would be billed at the ` +
          `most expensive rate we know of. Add its rate to src/lib/llm-pricing.ts first.`,
      };
    }
    merged[task] = trimmed;
  }

  const changed = MODEL_TASKS.filter((task) => merged[task] !== current[task]);
  if (changed.length === 0) return { ok: true };

  await db.transaction(async (tx) => {
    await tx
      .insert(platformSettings)
      .values({ key: KEY, value: merged, updatedBy: actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: merged, updatedBy: actorId, updatedAt: new Date() },
      });

    await tx.insert(events).values({
      actorType: "user",
      actorId,
      kind: "models.changed",
      subjectType: "platform_settings",
      subjectId: KEY,
      reason: changed
        .map((task) => `${task}: ${current[task]} -> ${merged[task]}`)
        .join("; "),
      payload: {
        changed: changed.map((task) => ({ task, from: current[task], to: merged[task] })),
      },
    });
  });

  return { ok: true };
}

/*
 * Re-exported for callers that want the vocabulary and the reader together.
 *
 * A convenience, not a second definition — these are the same bindings `src/lib/models.ts`
 * declares. A client component must import them from there, since this module is
 * `server-only`.
 */
export { MODEL_DEFAULTS, MODEL_TASKS, MODEL_TASK_META, isModelTask } from "@/lib/models";
export type { ModelSettings, ModelTask } from "@/lib/models";
