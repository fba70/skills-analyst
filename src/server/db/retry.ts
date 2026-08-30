import "server-only";

/**
 * Retrying a Neon connection, and refusing to retry anything else.
 *
 * Neon suspends an idle compute and wakes it on the next connection. The wake takes a
 * moment and the attempt that triggers it can fail outright, which is why Neon documents
 * exponential backoff with jitter as **required** rather than as a resilience nicety. A
 * cold start is not an incident; it is the normal behaviour of the product.
 *
 * ## The dangerous half of this idea
 *
 * "Retry the query" is one word away from "run the write twice". A retry is only safe when
 * the failure proves the statement never reached the server — and connection errors do not
 * all prove that. `ECONNRESET` can mean the socket died before the query was sent, or after
 * the server received it and while the reply was in flight. Retrying the second case
 * double-applies a write, silently, under load, which is far worse than the cold start it
 * was trying to paper over.
 *
 * So failures are split by what they prove, and the split is enforced by *where* the retry
 * happens:
 *
 * - **`connect`** — acquiring a connection. Nothing has been sent, so every
 *   connection-class failure is safe to retry. This is the cold-start path.
 * - **`query`** — a statement is in play. Only failures that happened while *establishing*
 *   the connection are retried; anything that could have interrupted an in-flight
 *   statement is surfaced to the caller.
 *
 * ## What is deliberately not retried
 *
 * `40001` (serialization failure) and `40P01` (deadlock) are the textbook retryables and
 * they are excluded on purpose. Both mean the statement *ran* and its transaction was
 * rolled back, so the correct retry unit is the whole transaction, not one statement —
 * retrying at this layer would re-issue a statement into a transaction Postgres has already
 * aborted. If transaction-level retry is ever wanted, it belongs around `db.transaction`,
 * where the callback can be replayed as a unit.
 *
 * `08007` (transaction_resolution_unknown) is excluded for the sharper version of the same
 * reason: it says nobody knows whether the commit landed. That is the one error where a
 * retry is definitely wrong.
 */

/** Retries after the first try. Three is enough for a wake; more just delays a real outage. */
const MAX_RETRIES = 3;
/** First backoff, before jitter. Neon wakes in well under a second in the common case. */
const BASE_DELAY_MS = 100;
const FACTOR = 3;
/** No single wait longer than this — a request budget is not unlimited. */
const MAX_DELAY_MS = 2_000;

/**
 * Failures that prove the statement never reached the server.
 *
 * Safe to retry from either phase: no work can have been done.
 */
const ESTABLISHMENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", // nothing listening yet — the classic cold start
  "ETIMEDOUT", // the connect attempt timed out
  "EAI_AGAIN", // transient DNS
  "ENETUNREACH",
  "ENOTFOUND",
  "57P03", // cannot_connect_now — Postgres is starting up
  "53300", // too_many_connections
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
]);

/**
 * Failures where a connection existed and was lost.
 *
 * Safe only when no statement was in flight — that is, from `connect`. See the note above
 * on why this set must never be retried at the `query` phase.
 */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08P01", // protocol_violation
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
]);

/**
 * `pg` reports some connection problems as plain messages with no code at all.
 *
 * Matched narrowly and only for the establishment phase, because a message match is a
 * weaker signal than a SQLSTATE and this is the direction where a wrong guess is unsafe.
 */
const ESTABLISHMENT_MESSAGES = [
  "timeout exceeded when trying to connect",
  "connection terminated due to connection timeout",
];

export type RetryPhase = "connect" | "query";

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

export function isRetryable(error: unknown, phase: RetryPhase): boolean {
  if (!error) return false;

  const code = codeOf(error);
  if (code) {
    if (ESTABLISHMENT_CODES.has(code)) return true;
    return phase === "connect" && CONNECTION_LOST_CODES.has(code);
  }

  const message = ((error as { message?: string })?.message ?? "").toLowerCase();
  if (ESTABLISHMENT_MESSAGES.some((needle) => message.includes(needle))) return true;

  // `pg` throws this bare when a pooled socket dies. It cannot say whether a statement was
  // in flight, so it is retried only where nothing can have been.
  return phase === "connect" && message.includes("connection terminated unexpectedly");
}

/** Full jitter: the whole delay is randomised, so a wave of clients does not re-collide. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * FACTOR ** attempt);
  return Math.round(random() * ceiling);
}

export type RetryOptions = {
  phase: RetryPhase;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error, options.phase)) throw error;

      const delay = backoffDelay(attempt, options.random);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
}
