import "server-only";

/**
 * Runs `worker` over `items`, at most `limit` at a time, preserving input order.
 *
 * Lifted out of the GitHub connector, where it already carried this comment: sequential
 * fetching "made a 12-file skill take a dozen round-trips end to end, and a large one
 * minutes." The same lesson had never been applied to the *read* side — validation,
 * structure extraction and signature building each pulled every bundle back from object
 * storage one at a time, and measured against a real pass that was **42 of 50 minutes**.
 *
 * ## Order is preserved, deliberately
 *
 * Results come back in input order even though they complete out of order, so a caller can
 * zip them against its input without tracking indices. That is what makes this a drop-in
 * replacement for a `for` loop rather than a rewrite of every call site.
 *
 * ## Failures are the caller's to shape
 *
 * A rejection propagates, exactly as it would from a sequential loop. Callers that need
 * per-item tolerance — `syncSource` collecting `failedSkills`, say — catch inside the
 * worker, which keeps "one bad item must not cost the batch" a decision made where the
 * batch's meaning is known rather than one imposed here.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: width }, async () => {
      // A shared cursor rather than pre-sliced chunks: chunking makes every lane wait for
      // the slowest item in its own chunk, which with bundles of wildly different sizes
      // leaves most lanes idle at the end of a batch.
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

/**
 * Like `mapWithConcurrency`, but **one item can never cost the batch**.
 *
 * Every bulk loop in this pipeline wants the same three things: bounded parallelism, results
 * in input order, and a failure that is *recorded and skipped* rather than fatal. The first
 * two were a shared helper; the third was left to each call site to remember — and it was
 * forgotten, repeatedly, in exactly the places where it mattered most:
 *
 *   - `syncSource` wrapped the fetch but not the write, so one refused insert cost an entire
 *     6,864-skill repository;
 *   - `validatePending` wrapped nothing, so one unreadable bundle would discard a batch of
 *     500 verdicts.
 *
 * Both were latent while the loops were sequential and fired the moment they were not. The
 * lesson is not "add another try/catch" — it is that isolation should be a property of the
 * primitive, so that forgetting it is not something a call site is able to do.
 *
 * Returns the successes in order plus the failures with their inputs, and never rejects.
 * A caller that genuinely wants fail-fast should use `mapWithConcurrency` and mean it.
 */
export type SettledFailure<T> = { item: T; index: number; error: unknown };

export async function mapSettled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; failures: SettledFailure<T>[] }> {
  const failures: SettledFailure<T>[] = [];
  const outcomes = await mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { ok: true as const, value: await worker(item, index) };
    } catch (error) {
      failures.push({ item, index, error });
      return { ok: false as const };
    }
  });

  const results: R[] = [];
  for (const outcome of outcomes) if (outcome.ok) results.push(outcome.value);
  return { results, failures };
}
