import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { LLM_OFF_DETAIL, LLM_OFF_HEADLINE } from "../src/lib/llm-mode";

/**
 * A deployment with `LLM_ENABLED` unset reaches no model, and still does everything else.
 *
 *   pnpm verify:llm-off
 *
 * Free, and it stays free by construction: every assertion here is about a call that must
 * **not** happen. Nothing in this file can reach a provider even if the switch were on.
 *
 * ## What is actually at risk
 *
 * The requirement is narrow and the failure modes are not. *Users may register and search;
 * nobody may spend a token.* Three ways that goes wrong:
 *
 *   1. **A new model call site with no gate.** Twelve files reach `generateText`,
 *      `streamText` or `embedMany` today and every one of them calls `assertWithinBudget` or
 *      `assertConversationBudget` first. That is a convention held up by review. The
 *      thirteenth is the one that spends, and it spends silently — no error, no log, only a
 *      bill. So the scan below is over the call *sites*, not over the switch.
 *   2. **A check that cannot observe the switch.** `llmEnabled()` reads the environment when
 *      it is called rather than when the module loads, precisely so that a suite can flip it.
 *      A module-level constant would be captured before any test could set it — ESM hoists
 *      imports — and every assertion below would pass against a frozen value. So the positive
 *      control runs first: the gate must be seen to *allow* a call before its refusal means
 *      anything.
 *   3. **Switching off more than was asked.** Registering, searching, reading a skill,
 *      validating and exporting are server compute and must be unaffected. The reachability
 *      walk asserts the registry read path never imports the model SDK at all — so it cannot
 *      be collaterally refused, whatever happens to the budget code.
 *
 * ## Why the reachability walk has a positive control too
 *
 * "No file reachable from the registry imports `ai`" is the shape of claim this codebase has
 * been burned by: a grep that structurally could not see what it was looking for returned
 * clean and meant nothing. So the same walker is pointed at `builder/generate.ts`, which must
 * come back **finding** the import. A walker that finds nothing anywhere proves nothing
 * anywhere.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const SRC = resolve(import.meta.dirname, "..", "src");

/** Source with comments removed, because a scan that matches its own prose proves nothing. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
console.info("\nThe switch can be seen to work, in both directions");
// ---------------------------------------------------------------------------------------

/*
 * The positive control first. Everything after this is an assertion that a call was refused,
 * and a refusal is only evidence if the same code path was observed letting a call through.
 */
process.env.LLM_ENABLED = "1";
const { assertLlmEnabled, llmEnabled, LlmDisabledError } = await import(
  "../src/server/billing/spend"
);

check("a truthy LLM_ENABLED reads as on", llmEnabled());
let allowed = true;
try {
  assertLlmEnabled();
} catch {
  allowed = false;
}
check("and the gate allows the call", allowed);

for (const spelling of ["1", "true", "on", "yes", "TRUE", " on "]) {
  process.env.LLM_ENABLED = spelling;
  if (!llmEnabled()) check(`"${spelling}" reads as on`, false);
}
check("the truthy spellings all read as on", true, "1, true, on, yes, case and space tolerant");

/*
 * Unset, not "0". The default is the case that matters: a deployment nobody configured is
 * exactly the deployment this exists to protect, which is why `CRON_SECRET` fails closed too.
 */
delete process.env.LLM_ENABLED;
check("unset reads as OFF — the default is off, not on", !llmEnabled());
for (const spelling of ["", "0", "false", "off", "no", "maybe"]) {
  process.env.LLM_ENABLED = spelling;
  if (llmEnabled()) check(`"${spelling}" must read as off`, false);
}
delete process.env.LLM_ENABLED;
check("and so does every other value", true, "empty, 0, false, off, no, and anything unknown");

// ---------------------------------------------------------------------------------------
console.info("\nWith it off, both gates refuse — before the database, not after");
// ---------------------------------------------------------------------------------------

let refusal: unknown = null;
try {
  assertLlmEnabled();
} catch (error) {
  refusal = error;
}
check("the switch throws rather than returning a flag", refusal instanceof LlmDisabledError);
check(
  "and it is its own error type, not a budget refusal",
  (refusal as Error)?.name === "LlmDisabledError",
  "a catch for BudgetExceededError would tell the reader to wait for a reset",
);
check(
  "the refusal carries the sentence the pages render",
  (refusal as Error)?.message === `${LLM_OFF_HEADLINE} ${LLM_OFF_DETAIL}`,
  "one definition, so a page cannot promise what a server refuses",
);

/*
 * The org gate, end to end, with the switch off.
 *
 * This is the assertion that matters most: `assertWithinBudget` is the line eleven call sites
 * already have, so a refusal here is a refusal at every one of them.
 */
const { assertWithinBudget } = await import("../src/server/billing/spend");
let orgGate: unknown = null;
try {
  await assertWithinBudget("builder", "00000000-0000-0000-0000-000000000000");
} catch (error) {
  orgGate = error;
}
check("assertWithinBudget refuses an org call", orgGate instanceof LlmDisabledError);

let platformGate: unknown = null;
try {
  await assertWithinBudget("corpus_taxonomy", null);
} catch (error) {
  platformGate = error;
}
check(
  "and a platform call, which is not exempt",
  platformGate instanceof LlmDisabledError,
  "the cron route runs as platform work; a convention is not a mechanism",
);

const { assertConversationBudget, canStartConversation } = await import(
  "../src/server/billing/conversation"
);
let turnGate: unknown = null;
try {
  await assertConversationBudget({
    conversationId: "verify-llm-off",
    orgId: "00000000-0000-0000-0000-000000000000",
    turns: 0,
  });
} catch (error) {
  turnGate = error;
}
check("the streaming gate refuses a turn", turnGate instanceof LlmDisabledError);

const start = await canStartConversation("00000000-0000-0000-0000-000000000000");
check(
  "a conversation is declined on the button, not at the first turn",
  start.ok === false && start.message === `${LLM_OFF_HEADLINE} ${LLM_OFF_DETAIL}`,
  "opening one would cost the greeting it could not send",
);

/*
 * Order, asserted on the source rather than on a stopwatch.
 *
 * Both gates read the ledger, and a switch checked *after* that read makes the refusal depend
 * on the database being up — which turns a configured deployment into a broken-looking one
 * during any database incident. Same technique `verify:stream` uses to pin the budget check
 * ahead of `streamText`.
 */
const spendSrc = code(join(SRC, "server", "billing", "spend.ts"));
const gateBody = spendSrc.slice(spendSrc.indexOf("export async function assertWithinBudget"));
check(
  "the switch is checked before the budget is read",
  gateBody.indexOf("assertLlmEnabled()") < gateBody.indexOf("await budgetState("),
  "a refusal must not need the database",
);

// ---------------------------------------------------------------------------------------
console.info("\nEvery model call site sits behind one of the two gates");
// ---------------------------------------------------------------------------------------

const CALLS = /\b(generateText|streamText|generateObject|streamObject|embedMany|embed)\s*\(/;
/*
 * A *call*, not a mention. The first version matched the bare name, which the destructured
 * `const { assertWithinBudget, recordUsage } = await import(...)` at the top of half these
 * files satisfies on its own — so deleting the actual gate line left the scan green. Caught by
 * deleting one and re-running, which is the only way that class of hole is ever found.
 */
const GATES = /\b(assertWithinBudget|assertConversationBudget)\s*\(/;

const serverFiles = walkFiles(join(SRC, "server"));
const callers = serverFiles.filter((path) => CALLS.test(code(path)));
/* A whitelist that matched nothing passes for the wrong reason. */
check(
  "the scan finds the model call sites at all",
  callers.length >= 8,
  `${callers.length} files call the SDK`,
);

const ungated = callers.filter((path) => !GATES.test(code(path)));
check(
  "and every one of them names a gate",
  ungated.length === 0,
  ungated.length === 0
    ? "a new call site inherits the switch for free"
    : ungated.map((p) => p.replace(`${SRC}/`, "src/")).join(", "),
);

/*
 * The gates themselves must reach the switch. Asserted separately, because "every caller names
 * a gate" and "the gate refuses" are two claims, and a check whose condition cannot fail —
 * `a.length === 0 || b === b` — is not a check.
 */
check(
  "assertWithinBudget calls the switch",
  /assertLlmEnabled\(\)/.test(spendSrc),
);
check(
  "assertConversationBudget calls the switch",
  /assertLlmEnabled\(\)/.test(code(join(SRC, "server", "billing", "conversation.ts"))),
);

// ---------------------------------------------------------------------------------------
console.info("\nA refusal is not a broken draft and not a failed batch");
// ---------------------------------------------------------------------------------------

/*
 * Two handlers already sort a budget refusal away from a real failure, and both had to learn
 * about the switch. Asserted on the source rather than by driving a draft through the whole
 * builder, because what is at stake is which branch the error lands in, and the branch is the
 * thing being read. The failure mode either way is quiet and wrong: a draft whose inputs are
 * fine marked `failed`, and a backfill reporting hundreds of failures for one refusal.
 */
const draftsSrc = code(join(SRC, "server", "builder", "drafts.ts"));
check(
  "a refused generation leaves the draft collecting, not failed",
  /instanceof BudgetExceededError \|\| error instanceof LlmDisabledError/.test(draftsSrc),
  "the generic branch means 'this draft is broken', which it is not",
);

const embedSrc = code(join(SRC, "server", "analytics", "embeddings-run.ts"));
check(
  "a refused embedding batch ends the run rather than counting failures",
  /"LlmDisabledError"/.test(embedSrc) && /"BudgetExceededError"/.test(embedSrc),
  "nothing about the switch can change while the process runs",
);

// ---------------------------------------------------------------------------------------
console.info("\nRegistering and searching never reach a model at all");
// ---------------------------------------------------------------------------------------

/**
 * Follows relative and `@/` imports inside `src/`, and reports whether the SDK is reachable.
 *
 * Reachability rather than a flat grep, because the claim is about a *path* — the registry
 * read could import a helper that imports the SDK, and a grep over one file would call that
 * clean. Type-only imports are ignored: `import type` is erased and reaches nothing.
 */
function reachesModelSdk(entry: string): string | null {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    let body: string;
    try {
      body = code(current);
    } catch {
      continue;
    }
    if (/\bfrom\s+"ai"/.test(body) && !/\bimport\s+type\s+[^;]*from\s+"ai"/.test(body)) {
      return current.replace(`${SRC}/`, "src/");
    }

    for (const match of body.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"/g)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const base = spec.startsWith("@/")
        ? join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? resolve(dirname(current), spec)
          : null;
      if (!base) continue;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        try {
          if (statSync(candidate).isFile()) {
            queue.push(candidate);
            break;
          }
        } catch {
          /* Not this extension. */
        }
      }
    }
  }
  return null;
}

/* The control: the walker must be able to see the thing it is looking for. */
const generateHit = reachesModelSdk(join(SRC, "server", "builder", "generate.ts"));
check(
  "the walker can see the SDK where it really is",
  generateHit !== null,
  generateHit ?? "found nothing — every result below would be meaningless",
);

for (const [what, entry] of [
  ["the registry read path", join(SRC, "server", "dal", "skills.ts")],
  ["the session boundary", join(SRC, "server", "dal", "session.ts")],
  ["sign-in and sign-up", join(SRC, "server", "auth", "index.ts")],
  ["the export path", join(SRC, "server", "skills", "export.ts")],
] as const) {
  let hit: string | null;
  try {
    hit = reachesModelSdk(entry);
  } catch {
    check(`${what} was scanned`, false, `${entry} is missing — the entry point moved`);
    continue;
  }
  check(`${what} imports no model SDK`, hit === null, hit ?? "server compute only");
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
