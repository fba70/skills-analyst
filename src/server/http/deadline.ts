import "server-only";

/**
 * `fetch` with a deadline. Every outbound request in this codebase goes through it.
 *
 * ## The failure it exists to stop
 *
 * A bare `fetch` can wait for ever. Node's undici defaults do not cover the case that
 * actually happens: `headersTimeout` and `bodyTimeout` fire when *nothing* arrives, while a
 * half-open connection — the peer's return path dropped by a NAT, or a CDN edge that went
 * away mid-exchange — leaves the socket ESTABLISHED on our side and the read pending
 * indefinitely.
 *
 * That is not a theoretical risk. It hung two ingestion runs in one day: the process stayed
 * alive for hours holding a single ESTABLISHED HTTPS socket, burning no CPU and no GitHub
 * quota, and because the pass never finished it never wrote its completion event either — so
 * from the outside it looked like a run stuck on pass two rather than a hang. A run that
 * dies is visible; a run that waits is not.
 *
 * ## One implementation, deliberately
 *
 * There were ten unguarded `fetch` calls across connectors, the crawl, submissions and mail.
 * Ten copies of a timeout is nine chances to forget one, and the one that got forgotten
 * would be the next hang — with no way to tell from the symptom which call site it was.
 *
 * `AbortSignal.timeout` covers the whole exchange rather than a single phase, which is the
 * property that matters: the hang can happen at connect, at headers, or partway through a
 * body, and all three present identically from outside.
 */

/**
 * 30 seconds.
 *
 * Far above a healthy response — the p99 against GitHub here is under two — and far below
 * "wait for ever". The point is not to be tight; it is to be finite, so a dead peer becomes
 * one failed item that the caller's existing error handling survives.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * For calls whose response is legitimately large and slow to generate.
 *
 * A recursive git-tree on a repository with tens of thousands of entries is the case: the
 * response can reach the API's ~100k-entry ceiling, and GitHub builds it on demand. Holding
 * those to the same 30 seconds as a single file fetch would convert a slow-but-working
 * enumeration into a failure — and R1.5 treats an incomplete enumeration as deletion, so a
 * false timeout there is not a retry, it is a tombstone.
 *
 * Still finite. The point was never tightness; it was that every wait has an end.
 */
export const LARGE_RESPONSE_TIMEOUT_MS = 120_000;

export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (!aborted) throw error;
    /**
     * Rethrown with the URL in the message.
     *
     * A raw `AbortError` says "This operation was aborted" and names neither the host nor
     * the reason, so it reads like a bug in our own code. The per-item failure lists that
     * surface these — `failedSkills`, `failedSources` — are only useful for deciding whether
     * to retry if they say *what* stopped responding.
     */
    throw new Error(`timed out after ${timeoutMs}ms: ${url}`, { cause: error });
  }
}
