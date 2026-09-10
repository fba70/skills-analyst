import { NextResponse } from "next/server";

import { API_CACHE_SECONDS, API_ERROR_STATUS, type ApiError } from "@/lib/api";

/**
 * What every route in `/api/v1` shares (Doc 2 R8.6, plan step F4).
 *
 * Not a route itself — the leading underscore keeps it out of Next's router, which treats every
 * `route.ts` under `app/` as an endpoint and would otherwise publish this one.
 *
 * These are route handlers for the documented reason: JSON over HTTP to a third party is a wire
 * protocol, which a server component (renders HTML) and a server action (returns a value to our
 * own bundle) cannot be. They import one server module and no database module, no query builder
 * and no driver.
 */

/**
 * Charge one read against the public limiter, or refuse.
 *
 * Keyed on the forwarded address, because an anonymous API has no identity to offer — the same
 * bound-on-accidents-not-abuse trade the MCP endpoint documents, and the reason MCP asks for a
 * token while this does not. **Fails open**, like the other read scopes: the data is public and
 * read-only, and taking the corpus dark because a counter table blinked is worse than a burst.
 */
export async function allowRead(request: Request): Promise<Response | null> {
  const { consume } = await import("@/server/mcp/rate-limit");
  const decision = await consume(request, "publicApi");
  if (decision.allowed) return null;
  return fail("rate-limited", decision.message, {
    "Retry-After": String(decision.retryAfterSeconds),
  });
}

export function ok(body: unknown): Response {
  return NextResponse.json(body, {
    headers: {
      /*
       * Public facts about a corpus that changes twice a day, and the API exists so people stop
       * scraping pages — serving it uncached would replace one load with another. Short enough
       * that a takedown propagates within the hour, which is the one update that must not linger.
       */
      "Cache-Control": `public, max-age=${API_CACHE_SECONDS}, stale-while-revalidate=60`,
    },
  });
}

export function fail(
  error: ApiError,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return NextResponse.json({ error, message }, { status: API_ERROR_STATUS[error], headers });
}
