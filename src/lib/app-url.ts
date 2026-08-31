/**
 * Where this deployment is reachable.
 *
 * Not a constant, because Vercel gives every preview deployment its own hostname. If the
 * base URL is pinned to production, Better Auth treats a preview request as cross-origin
 * and sign-in fails there while working in production — a failure that only shows up
 * after merge, which is the worst time to find it.
 *
 * Order:
 *   1. an explicit BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL — set this for Production only
 *   2. VERCEL_PROJECT_PRODUCTION_URL — the stable production host
 *   3. VERCEL_URL — this specific deployment (previews)
 *   4. localhost
 *
 * Safe on the client: only NEXT_PUBLIC_* and the inlined build-time values are read
 * there, and `process.env` lookups must be written out in full for Next to inline them.
 */

function normalize(value: string | undefined): string | null {
  if (!value) return null;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

export function getAppUrl(): string {
  return (
    normalize(process.env.NEXT_PUBLIC_APP_URL) ??
    normalize(process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL) ??
    normalize(process.env.NEXT_PUBLIC_VERCEL_URL) ??
    "http://localhost:3000"
  );
}

/** Server-side equivalent; also sees the non-public Vercel variables. */
export function getServerAppUrl(): string {
  return (
    normalize(process.env.BETTER_AUTH_URL) ??
    normalize(process.env.NEXT_PUBLIC_APP_URL) ??
    normalize(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normalize(process.env.VERCEL_URL) ??
    "http://localhost:3000"
  );
}

/**
 * Hosts allowed to make auth requests. Preview deployments change hostname per commit,
 * so the current deployment's own URL has to be trusted explicitly.
 */
export function getTrustedOrigins(): string[] {
  return [
    ...new Set(
      [
        normalize(process.env.BETTER_AUTH_URL),
        normalize(process.env.NEXT_PUBLIC_APP_URL),
        normalize(process.env.VERCEL_PROJECT_PRODUCTION_URL),
        normalize(process.env.VERCEL_URL),
        "http://localhost:3000",
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}

/**
 * The address to **print in documentation**, which is a different question from the two above.
 *
 * `getAppUrl()` answers "where is this deployment reachable", and on a developer's laptop the
 * honest answer is `http://localhost:3000`. That is right for auth and wrong for a copyable
 * example, because the reader is not on that laptop: a config snippet or a curl showing
 * localhost is one the reader pastes, cannot connect to, and blames the API for.
 *
 * So this deliberately never falls back to localhost. Documentation names the public host
 * even when rendered locally — the example stays correct for its audience rather than for
 * its renderer.
 *
 * `NEXT_PUBLIC_PRODUCTION_URL` is the override; the Vercel production host is the automatic
 * answer once deployed; the literal is the last resort so a fresh checkout with no
 * environment still prints something a reader can reach.
 */
export function getDocsOrigin(): string {
  return (
    normalize(process.env.NEXT_PUBLIC_PRODUCTION_URL) ??
    normalize(process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL) ??
    "https://skills-foundry.vercel.app"
  );
}
