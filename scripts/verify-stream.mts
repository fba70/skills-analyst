import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Client } from "pg";

import {
  CONVERSATION_BLOCKS,
  CONVERSATION_CAP_MICROS,
  CONVERSATION_MAX_TURNS,
  CONVERSATION_MIN_START_MICROS,
  conversationBlockMessage,
  formatConversationSpend,
} from "../src/lib/conversation";
import { MODEL_DEFAULTS, MODEL_TASKS } from "../src/lib/models";
import { rateFor } from "../src/lib/llm-pricing";

/**
 * Streaming is metered whatever the reader does, and a conversation has its own cap.
 *
 *   pnpm verify:stream
 *
 * Free. The model is `ai/test`'s mock, so the provider is never reached; the ledger half
 * writes a few rows against a throwaway conversation id and removes them in a `finally`
 * through the owner connection.
 *
 * ## What is actually at risk
 *
 * Two things, and both are money.
 *
 *   1. **A stream that is metered only if the client stays connected.** Every existing call
 *      site is one-shot and cannot finish without the caller learning it finished. A stream
 *      can: the tab closes, the provider still generated the tokens and still charges, and
 *      the code that would write the ledger row waits on a promise nobody will resolve. That
 *      is invisible under-billing — the same outcome as `recordUsage` writing unscoped and
 *      having every org row refused by RLS, which left RC.2 satisfied on paper only.
 *   2. **A conversation bounded only by the org cap.** Twenty turns against a `$5` monthly
 *      budget, each re-sending the transcript, is a cost that grows with the square of the
 *      conversation. Checked per call and nothing else, one runaway session eats a
 *      workspace's month and the author finds out at turn nineteen.
 *
 * Both are **reproduced before the fix is asserted**, so neither fixture can quietly stop
 * exercising the bug — the discipline `verify:http-deadline` and `verify:db-retry` set after
 * a grep that structurally could not see `aws4fetch`'s method-shaped `fetch` returned clean
 * and meant nothing.
 */

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function skip(name: string, why: string): void {
  console.info(`  skip  ${name} — ${why}`);
  skipped += 1;
}

/**
 * A mock that reports real-looking usage, so the cost arithmetic is the real arithmetic.
 *
 * The nested shape is the provider spec's, not the SDK's flattened one — `inputTokens.total`
 * is what a provider returns and `noCache` is the full-rate part. Written out rather than
 * simplified because `tokensFrom` derives the uncached remainder when a provider omits the
 * breakdown, and a fixture that never exercised the breakdown would leave that path untested.
 */
const MOCK_USAGE = {
  inputTokens: { total: 12_000, noCache: 12_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 800, text: 800, reasoning: 0 },
};
const MOCK_MODEL_ID = MODEL_DEFAULTS.interview;

function mockModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Tell me about " },
          { type: "text-delta", id: "0", delta: "the last time this went wrong." },
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: { unified: "stop" }, usage: MOCK_USAGE },
        ] as never,
        chunkDelayInMs: 1,
      }),
    }),
  });
}

// ---------------------------------------------------------------------------------------
console.info("\nThe conversation policy");
// ---------------------------------------------------------------------------------------

check(
  "a conversation cannot outspend the workspace it belongs to",
  CONVERSATION_CAP_MICROS < 5_000_000,
  `${formatConversationSpend(CONVERSATION_CAP_MICROS)} against a $5 default org cap`,
);

check(
  "and starting one needs meaningfully more than a single turn's room",
  CONVERSATION_MIN_START_MICROS > 0 && CONVERSATION_MIN_START_MICROS < CONVERSATION_CAP_MICROS,
  `${formatConversationSpend(CONVERSATION_MIN_START_MICROS)} to start`,
);

check(
  "the turn cap bounds the transcript growth that makes cost superlinear",
  CONVERSATION_MAX_TURNS > 0 && CONVERSATION_MAX_TURNS <= 50,
  `${CONVERSATION_MAX_TURNS} turns`,
);

/*
 * Three reasons, not a boolean, because they are three different things to tell an author —
 * and only one of them is a billing problem. A single `blocked` flag would put "your
 * workspace is out of money" and "this chat has gone on long enough" behind one sentence, and
 * the author would either wait a month for nothing or start a new session that cannot run.
 */
check(
  "a refusal names which of the three limits it hit",
  CONVERSATION_BLOCKS.length === 3 &&
    CONVERSATION_BLOCKS.includes("organisation") &&
    CONVERSATION_BLOCKS.includes("conversation") &&
    CONVERSATION_BLOCKS.includes("turns"),
  CONVERSATION_BLOCKS.join(", "),
);

const resetsAt = new Date("2026-10-01T00:00:00Z");
check(
  "the workspace refusal says when the money comes back",
  conversationBlockMessage("organisation", resetsAt).includes("2026-10-01"),
);
check(
  "the conversation and turn refusals say a new conversation is the way on",
  conversationBlockMessage("conversation", resetsAt).toLowerCase().includes("start a new") &&
    conversationBlockMessage("turns", resetsAt).toLowerCase().includes("start a new"),
);
/*
 * The two recoverable refusals must also say nothing was lost. An author fifteen turns into
 * describing how they actually work will not click again if the message reads like a crash.
 */
check(
  "and that nothing said so far is thrown away",
  ["organisation", "conversation", "turns"].every((block) =>
    /saved|already on the draft|nothing is lost/i.test(
      conversationBlockMessage(block as never, resetsAt),
    ),
  ),
);

check(
  "a fraction of a cent is shown as a fraction of a cent, not as $0.00",
  formatConversationSpend(1_200) === "$0.0012" && formatConversationSpend(0) === "$0",
  `${formatConversationSpend(1_200)}, ${formatConversationSpend(340_000)}`,
);

// ---------------------------------------------------------------------------------------
console.info("\nThe model id is a setting, and it is priced");
// ---------------------------------------------------------------------------------------

check(
  "interview is a task with a default, like every other paid call",
  MODEL_TASKS.includes("interview") && Boolean(MODEL_DEFAULTS.interview),
  MODEL_DEFAULTS.interview,
);

/*
 * An unpriced id is charged at `UNKNOWN_MODEL_RATE`, the most expensive rate known — right
 * for a budget and wrong as the silent consequence of a new task arriving without a rate.
 * The embedding model shipped this exact way: without its entry a 29-million-token backfill
 * would have been billed at $14.40 against a real $0.058.
 */
const interviewRate = rateFor(MODEL_DEFAULTS.interview);
check(
  "and its rate is in the price table rather than falling back to the unknown rate",
  interviewRate.inputPerMTok > 0 && rateFor("definitely/not-a-model").inputPerMTok !== interviewRate.inputPerMTok,
  `$${interviewRate.inputPerMTok}/MTok in`,
);

// ---------------------------------------------------------------------------------------
console.info("\nWhat the SDK actually does with a stream nobody reads");
// ---------------------------------------------------------------------------------------

/**
 * A dependency behaviour, pinned — the same job `verify:http-deadline` does for `AwsClient`.
 *
 * The seam was written expecting backpressure: nothing pulls, so nothing finishes, so
 * `totalUsage` never settles, so metering that hung off the reader would silently miss every
 * abandoned turn. **That is not how ai@7 behaves.** `streamText` drains the model stream
 * eagerly, so the usage resolves whether or not anybody reads it — measured below rather than
 * assumed, with a genuinely pull-based source, because the first version of this fixture used
 * `simulateReadableStream` and its timer pushed chunks on its own. A mock that self-drives
 * cannot observe backpressure, and a check that cannot observe the failure it is about is not
 * evidence.
 *
 * So `consumeStream()` in the seam is **belt-and-braces against a dependency, not a fix for a
 * live hang**, and it is worth keeping precisely because this check exists: if a future SDK
 * version stops draining eagerly, this goes red and names the line that has become critical.
 * The property that actually matters either way — an abandoned turn still reaches the ledger —
 * is asserted end to end further down, against the real `llm_usage` table.
 */
{
  let pulls = 0;
  const pullModel = new MockLanguageModelV4({
    doStream: async () => {
      const chunks = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "a" },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: { unified: "stop" }, usage: MOCK_USAGE },
      ];
      let i = 0;
      return {
        stream: new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (i < chunks.length) controller.enqueue(chunks[i++] as never);
            else controller.close();
          },
        }),
      };
    },
  });
  const unread = streamText({ model: pullModel, prompt: "hi" });
  const outcome = await Promise.race([
    unread.totalUsage.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 500)),
  ]);
  check(
    "the fixture can observe backpressure — the source only produces when pulled",
    pulls > 0,
    `${pulls} pulls`,
  );
  check(
    "ai@7 drains the model stream with no reader, so usage resolves regardless",
    outcome === "settled",
    outcome === "settled"
      ? "consumeStream in the seam is a guard against this changing, not a live fix"
      : "the SDK no longer drains eagerly — consumeStream in the seam is now load-bearing",
  );

  const consumed = streamText({ model: mockModel(), prompt: "hi" });
  void consumed.consumeStream();
  const usage = await consumed.totalUsage;
  check(
    "and the usage that comes back is the provider's, not a zero",
    usage.inputTokens === MOCK_USAGE.inputTokens.total &&
      usage.outputTokens === MOCK_USAGE.outputTokens.total,
    `${usage.inputTokens} in, ${usage.outputTokens} out`,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe seam, against the real ledger");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("ledger checks", "no database connection — the checks above are complete without it");
}

const CONVERSATION_ID = `verify-stream-${Date.now()}`;

if (connected) {
  const orgRow = await owner.query<{ id: string }>(`select id from organization limit 1`);
  const orgId = orgRow.rows[0]?.id ?? null;

  const hasPurpose = await owner.query<{ n: string }>(
    `select count(*)::text as n from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'llm_purpose' and e.enumlabel = 'interview'`,
  );

  /*
   * The ledger half runs before the migration as well as after it.
   *
   * `interview` is a new enum value, so on a database that has not taken migration 0032 the
   * probe bills `builder` instead and says so. Everything else — the gate, the subject, the
   * token counts, the abandoned stream, the conversation cap — is identical, and none of it
   * is about which label the row carries.
   *
   * Skipping the whole section until the migration lands would have meant handing over a
   * seam whose only end-to-end evidence was that it compiled. That is the shape this file's
   * own header warns about, one level up.
   */
  const purposeReady = hasPurpose.rows[0].n !== "0";
  const probePurpose = purposeReady ? "interview" : "builder";
  if (!purposeReady) {
    console.info(
      "  note  the interview purpose is not in the enum yet (migrations/0032) — " +
        "billing the probe as builder, which changes nothing these checks assert",
    );
  }

  if (!orgId) {
    skip("ledger checks", "no organisation exists to bill — sign up once, then re-run");
  } else {
    try {
      const { conversationBudget, assertConversationBudget, canStartConversation, ConversationBudgetError } =
        await import("../src/server/billing/conversation");
      const { assertWithinBudget } = await import("../src/server/billing/spend");
      const { streamMeteredWithModel } = await import("../src/server/llm/stream");

      /*
       * A fresh conversation id, so the sums below describe this run and nothing else. Reading
       * a real conversation's spend would make the assertions depend on data somebody else
       * wrote — the shape that made `verify:embeddings` pass on a condition that could not
       * fail.
       */
      const fresh = await conversationBudget({ conversationId: CONVERSATION_ID, orgId, turns: 0 });
      check(
        "a conversation nobody has had has spent nothing",
        fresh.spentMicros === 0 && fresh.blockedBy === null,
        `${formatConversationSpend(fresh.spentMicros)} spent`,
      );

      /*
       * The cap is the lesser of the two ceilings. A fixed one would advertise 50¢ to a
       * workspace with 20¢ left, and the author would watch a gauge that was lying from turn
       * one.
       */
      check(
        "its cap never exceeds what the workspace has left",
        fresh.capMicros <= CONVERSATION_CAP_MICROS,
        `${formatConversationSpend(fresh.capMicros)}`,
      );

      // ---- the abandoned stream, through the real seam ----

      const before = await ledgerRows(owner, CONVERSATION_ID);
      const stream = await streamMeteredWithModel(mockModel(), MOCK_MODEL_ID, {
        task: "interview",
        purpose: probePurpose,
        orgId,
        conversationId: CONVERSATION_ID,
        turns: 0,
        system: "You are interviewing an author.",
        messages: [{ role: "user", content: "I review terraform plans." }],
      });

      /*
       * One chunk, then walk away — the closed tab, reproduced. The `break` leaves the async
       * iterator unfinished, which is what a disconnect does.
       */
      for await (const chunk of stream.textStream) {
        void chunk;
        break;
      }

      const metered = await stream.metered;
      check(
        "an abandoned stream is still metered",
        metered.costMicros > 0,
        `${formatConversationSpend(metered.costMicros)} charged after one chunk was read`,
      );
      check(
        "and the full text was still produced server-side, not just the chunk that was read",
        metered.text.includes("went wrong"),
        `${metered.text.length} chars`,
      );

      const after = await ledgerRows(owner, CONVERSATION_ID);
      check(
        "exactly one ledger row was written for the turn",
        after.length === before.length + 1,
        `${after.length} row(s)`,
      );
      /*
       * The subject is what the conversation budget sums on. A writer and a reader using two
       * different strings would report every conversation as free — consistently, which is the
       * kind of wrong nobody notices.
       */
      check(
        "and it carries the subject the conversation budget sums on",
        after[0]?.subject_type === "conversation" && after[0]?.subject_id === CONVERSATION_ID,
        `${after[0]?.subject_type}/${String(after[0]?.subject_id).slice(0, 20)}`,
      );
      check(
        "billed to the workspace and to an org purpose, not to the platform",
        after[0]?.purpose === probePurpose && after[0]?.org_id === orgId,
        `${after[0]?.purpose}`,
      );
      if (purposeReady) {
        check(
          "and the purpose is `interview`, distinct from one-shot authoring",
          after[0]?.purpose === "interview",
        );
      } else {
        skip("the interview purpose is recorded", "apply migrations/0032, then re-run");
      }
      /*
       * Zero recorded tokens is what an unmetered path looks like from the outside — the shape
       * of the `embedMany` trap, where reading `usage.inputTokens` instead of `usage.tokens`
       * returned undefined and metered a whole backfill as free.
       */
      check(
        "with real token counts, not zeros",
        Number(after[0]?.input_tokens) > 0 && Number(after[0]?.output_tokens) > 0,
        `${after[0]?.input_tokens} in, ${after[0]?.output_tokens} out`,
      );

      // ---- the conversation cap, and the check that would have missed it ----

      const spent = await conversationBudget({ conversationId: CONVERSATION_ID, orgId, turns: 1 });
      check(
        "the conversation's own spend is now visible to its budget",
        spent.spentMicros === Number(after[0]?.cost_micros),
        `${formatConversationSpend(spent.spentMicros)}`,
      );

      /*
       * Push this conversation past its own cap while leaving the workspace plenty of room,
       * then show that the *old* gate passes and the new one refuses. Reproducing the bug is
       * the point: a suite that only asserted the new gate would pass just as happily if the
       * conversation cap were never consulted.
       */
      await owner.query(
        `insert into llm_usage (org_id, purpose, model, input_tokens, cache_write_tokens,
                                cache_read_tokens, output_tokens, cost_micros, subject_type, subject_id)
         values ($1, $5, $2, 0, 0, 0, 0, $3, 'conversation', $4)`,
        [orgId, MOCK_MODEL_ID, CONVERSATION_CAP_MICROS, CONVERSATION_ID, probePurpose],
      );

      const orgStillFine = await assertWithinBudget(probePurpose, orgId).then(
        () => true,
        () => false,
      );
      check(
        "the per-call org check still passes — it cannot see a conversation at all",
        orgStillFine,
        "which is why the conversation cap is not redundant",
      );

      const refused = await assertConversationBudget({
        conversationId: CONVERSATION_ID,
        orgId,
        turns: 1,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      check(
        "the conversation check refuses the next turn",
        refused instanceof ConversationBudgetError && refused.block === "conversation",
        refused instanceof ConversationBudgetError ? refused.block : "not refused",
      );
      check(
        "and its message tells the author their accepted blocks are safe",
        refused instanceof ConversationBudgetError &&
          /already on the draft/i.test(refused.message),
      );

      /*
       * A refused turn must cost nothing. The gate is before the call, so no provider is
       * reached and no row is written — if this ever fails, the check has moved after the
       * spend and the cap has become a suggestion.
       */
      const beforeRefusal = await ledgerRows(owner, CONVERSATION_ID);
      const threw = await streamMeteredWithModel(mockModel(), MOCK_MODEL_ID, {
        task: "interview",
        purpose: probePurpose,
        orgId,
        conversationId: CONVERSATION_ID,
        turns: 1,
        system: "s",
        messages: [{ role: "user", content: "again" }],
      }).then(
        () => false,
        () => true,
      );
      const afterRefusal = await ledgerRows(owner, CONVERSATION_ID);
      check(
        "a refused turn throws before the model and writes no ledger row",
        threw && afterRefusal.length === beforeRefusal.length,
        `${afterRefusal.length} rows, unchanged`,
      );

      // ---- the turn cap is a different limit, and says so ----

      const outOfTurns = await conversationBudget({
        conversationId: `${CONVERSATION_ID}-turns`,
        orgId,
        turns: CONVERSATION_MAX_TURNS,
      });
      check(
        "a conversation that has spent nothing can still run out of turns",
        outOfTurns.spentMicros === 0 && outOfTurns.blockedBy === "turns",
        `${outOfTurns.blockedBy}`,
      );

      const start = await canStartConversation(orgId);
      check(
        "and a workspace with budget can start one",
        start.ok,
        start.ok ? formatConversationSpend(start.budget.remainingMicros) + " of room" : start.message,
      );
    } finally {
      /*
       * In a `finally`, through the owner connection, because `llm_usage` has no DELETE policy
       * — the application must not be able to erase its own charges. `verify:spend`'s first
       * version learned this by spending the real $50 platform budget and then being unable to
       * clean up, blocking corpus analysis until somebody removed the rows by hand.
       */
      const removed = await owner.query(`delete from llm_usage where subject_id = $1`, [
        CONVERSATION_ID,
      ]);
      console.info(`  note  ${removed.rowCount} probe ledger row(s) removed`);
    }
  }

  await owner.end().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
console.info("\nEvery streaming call goes through the seam");
// ---------------------------------------------------------------------------------------

/**
 * A source-tree assertion, because it is a property of the code.
 *
 * The seam is only worth having if it is the only way to stream. A second `streamText` call
 * somewhere else would be a call with no budget gate and no guaranteed metering, and it would
 * look completely ordinary in review — which is exactly how the four unguarded `r2Fetch` calls
 * survived a grep that returned clean.
 */
{
  const ALLOWED = new Set(["src/server/llm/stream.ts"]);
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\bstreamText\s*\(/.test(readFileSync(path, "utf8"))) callers.push(path);
    }
  };
  walk("src");

  const unexpected = callers.filter((path) => !ALLOWED.has(path));
  check(
    "streamText is called in one place",
    unexpected.length === 0,
    unexpected.length === 0 ? [...ALLOWED].join(", ") : `also in ${unexpected.join(", ")}`,
  );
  check(
    "and that place was found, so an empty result is not a pass",
    callers.some((path) => ALLOWED.has(path)),
    `${callers.length} caller(s)`,
  );

  const seam = readFileSync("src/server/llm/stream.ts", "utf8");
  check(
    "the seam drains the stream itself rather than trusting the reader",
    /result\.consumeStream\(\)/.test(seam),
  );
  check(
    "it resolves the model from the setting, never from a constant",
    /modelFor\(input\.task\)/.test(seam) && !/anthropic\/|google\/|openai\//.test(seam),
  );
  check(
    "and its budget gate runs before streamText, not after",
    seam.indexOf("assertConversationBudget(") < seam.indexOf("streamText({"),
  );
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);

async function ledgerRows(client: Client, conversationId: string) {
  const rows = await client.query(
    `select purpose, org_id, model, input_tokens, output_tokens, cost_micros,
            subject_type, subject_id
       from llm_usage where subject_id = $1 order by at desc`,
    [conversationId],
  );
  return rows.rows as Array<Record<string, unknown>>;
}
