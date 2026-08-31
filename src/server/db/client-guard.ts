import "server-only";

/**
 * Stops a dropped socket from killing the process.
 *
 * ## The asymmetry in `pg` that this exists for
 *
 * A pooled client has an `error` listener only some of the time, and the gap is not where
 * you would guess:
 *
 * - **Idle in the pool** — `pg-pool` attaches `idleListener`, which removes the client and
 *   re-emits on the pool. Safe, *provided the pool itself has an `error` listener*.
 * - **Checked out by `pool.query`** — `pg-pool` attaches `client.once('error', onError)`
 *   around the query and removes it afterwards. Safe.
 * - **Checked out by `pool.connect()`** — nothing is attached at all. `_acquireClient`
 *   removes the idle listener and the caller gets a bare client.
 *
 * That last case is every `db.transaction()`, because Drizzle takes a client from
 * `connect()` and holds it for the callback. And `Client._handleErrorEvent` ends with an
 * **unconditional** `this.emit('error', err)` — it fires even after `_errorAllQueries` has
 * already rejected the in-flight query. An EventEmitter emitting `error` with no listener
 * throws, so the whole process dies:
 *
 * ```
 * Error: read ETIMEDOUT
 *     at TLSWrap.onStreamRead
 * Emitted 'error' event on Client instance at:
 *     at Client._handleErrorEvent (pg/lib/client.js:422:10)
 * ```
 *
 * That killed a 60-pass ingestion run at pass 26. Nothing in the application could have
 * caught it: it is an event, not a rejected promise, so no `try`/`catch` and no retry
 * wrapper is ever offered the chance.
 *
 * ## Swallowing here is correct, not lazy
 *
 * The guard deliberately does nothing but log. The error has already been delivered to the
 * caller by the mechanism that matters — `_errorAllQueries` rejects any in-flight query,
 * and if none was in flight `pg` sets `_queryable = false` so the *next* statement in the
 * transaction rejects with a real error. Either way the transaction fails as a rejected
 * promise, which is what the calling code is written to handle. The event is a second
 * delivery of the same fact, and the only thing to do with it is not die.
 *
 * This mirrors what `pool.query` already does. It is not a new idea, just applied to the
 * path `pg` left uncovered.
 */

/** The shape we need from a `pg` client, kept minimal so a fake can stand in. */
export type GuardableClient = {
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: "error", listener: (err: Error) => void): unknown;
  release?: (err?: Error | boolean) => unknown;
};

export type GuardOptions = {
  /** Called with any error the guard absorbs. Logging, never rethrowing. */
  onError?: (error: Error) => void;
};

/**
 * Attaches an `error` listener for as long as the caller holds the client.
 *
 * The listener is removed on release, so a client going back into the pool is handed
 * cleanly to `pg`'s own `idleListener` rather than accumulating one of ours per checkout —
 * a leak that would show up as a MaxListenersExceededWarning after a few thousand
 * transactions, which is exactly the workload this is for.
 */
export function guardClient<T extends GuardableClient>(client: T, options: GuardOptions = {}): T {
  const guard = (error: Error) => {
    options.onError?.(error);
  };

  client.on("error", guard);

  const release = client.release;
  if (typeof release === "function") {
    // Wrapped rather than replaced: `pg-pool` installs a `_releaseOnce` here that throws on
    // a double release, and that check has to keep working — so the original is always the
    // thing that decides, and this only takes the listener off on the way through.
    client.release = function guardedRelease(this: unknown, err?: Error | boolean) {
      client.removeListener("error", guard);
      return release.call(client, err);
    };
  }

  return client;
}
