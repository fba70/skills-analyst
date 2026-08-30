import "dotenv/config";

import { backoffDelay, isRetryable, withRetry } from "../src/server/db/retry";

/**
 * Proves the retry rules (Neon cold starts, Doc 3).
 *
 *   pnpm verify:db-retry
 *
 * No database and no network: the risk in a retry is entirely in *what it decides to do
 * again*, and that is pure logic. A test that needed a real cold start could only be run
 * by waiting for one.
 *
 * The property that matters is the unsafe direction. Retrying too little costs a request;
 * retrying too much runs a write twice, silently, under load. So most of what follows
 * checks that things are **not** retried.
 */

let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const err = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });

// --- Cold starts are retried, from both phases -------------------------------
{
  const coldStart = ["ECONNREFUSED", "ETIMEDOUT", "57P03", "53300"];
  check(
    "connection-establishment failures retry from either phase",
    coldStart.every((code) => isRetryable(err(code), "connect") && isRetryable(err(code), "query")),
    coldStart
      .map((c) => `${c}:${isRetryable(err(c), "connect")}/${isRetryable(err(c), "query")}`)
      .join(" "),
  );

  check(
    "pg's bare connect-timeout message is retried",
    isRetryable(new Error("timeout exceeded when trying to connect"), "query"),
    "a message-only connect timeout was not recognised",
  );
}

// --- A lost connection is retried only where nothing was in flight -----------
{
  const lost = ["ECONNRESET", "EPIPE", "08006", "57P01"];
  check(
    "a lost connection retries on connect",
    lost.every((code) => isRetryable(err(code), "connect")),
    lost.map((c) => `${c}:${isRetryable(err(c), "connect")}`).join(" "),
  );
  check(
    "a lost connection does NOT retry a statement — it may have run",
    lost.every((code) => !isRetryable(err(code), "query")),
    lost.map((c) => `${c}:${isRetryable(err(c), "query")}`).join(" "),
  );

  check(
    "`connection terminated unexpectedly` does not retry a statement",
    !isRetryable(new Error("Connection terminated unexpectedly"), "query") &&
      isRetryable(new Error("Connection terminated unexpectedly"), "connect"),
    "the bare pg message was classified the same way in both phases",
  );
}

// --- Everything else is surfaced, not retried --------------------------------
{
  const never = [
    "23505", // unique_violation — retrying cannot help and hides a real conflict
    "23503", // foreign_key_violation
    "42P01", // undefined_table
    "42501", // insufficient_privilege — an RLS refusal is an answer, not a blip
    "40001", // serialization_failure — the statement RAN; retry belongs at the transaction
    "40P01", // deadlock_detected — same
    "08007", // transaction_resolution_unknown — nobody knows if the commit landed
  ];
  check(
    "application and transaction errors are never retried",
    never.every((code) => !isRetryable(err(code), "connect") && !isRetryable(err(code), "query")),
    never
      .map((c) => `${c}:${isRetryable(err(c), "connect")}/${isRetryable(err(c), "query")}`)
      .join(" "),
  );
}

// --- The loop itself ---------------------------------------------------------
{
  const noSleep = async () => {};

  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw err("ECONNREFUSED");
      return "ok";
    },
    { phase: "query", sleep: noSleep },
  );
  check(
    "a retryable failure is retried until it succeeds",
    value === "ok" && calls === 3,
    `calls=${calls}, value=${value}`,
  );

  let attempts = 0;
  let thrown: string | null = null;
  try {
    await withRetry(
      async () => {
        attempts += 1;
        throw err("ECONNREFUSED");
      },
      { phase: "query", sleep: noSleep },
    );
  } catch (error) {
    thrown = (error as { code?: string }).code ?? null;
  }
  check(
    "it gives up and rethrows the original error",
    // Four tries: the first, plus MAX_RETRIES.
    attempts === 4 && thrown === "ECONNREFUSED",
    `attempts=${attempts}, thrown=${thrown}`,
  );

  let unique = 0;
  try {
    await withRetry(
      async () => {
        unique += 1;
        throw err("23505");
      },
      { phase: "query", sleep: noSleep },
    );
  } catch {
    /* expected */
  }
  check(
    "a non-retryable failure is tried exactly once",
    unique === 1,
    `a unique violation was attempted ${unique} times`,
  );
}

// --- Backoff shape -----------------------------------------------------------
{
  // Full jitter: the delay is uniform in [0, ceiling], so the ceiling is what grows.
  const ceilings = [0, 1, 2, 3].map((attempt) => backoffDelay(attempt, () => 1));
  const growing = ceilings.every((value, i) => i === 0 || value >= ceilings[i - 1]);
  check(
    "the backoff ceiling grows and is capped",
    growing && ceilings[ceilings.length - 1] <= 2_000,
    `ceilings=${ceilings.join(",")}`,
  );

  check(
    "jitter can produce a short delay, so clients do not re-collide",
    backoffDelay(3, () => 0) === 0,
    "a zero draw did not produce a zero delay",
  );
}

console.info(failures === 0 ? "\nRetry rules verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
