import { createMcpHandler } from "mcp-handler";

import { consume } from "@/server/mcp/rate-limit";
import { resolveToken, touchToken } from "@/server/mcp/tokens";
import { registerFreeTools } from "@/server/mcp/tools";

/**
 * The MCP endpoint (Doc 2 R8.8, free scope).
 *
 * ## Why a route handler is allowed here
 *
 * The repo rule is that queries live in `src/server/**` and route handlers get no database.
 * Both hold: this file touches no `@/server/db`, no `drizzle-orm`, no `pg`. It calls
 * `registerFreeTools`, whose tools are `server-only` and read through the DAL, so scope is
 * still resolved where the rule requires it and RLS still backs the decision.
 *
 * A route handler is used because MCP is a wire protocol: the client speaks JSON-RPC over
 * HTTP POST and expects a specific response shape. A server component renders HTML and a
 * server action returns a serialisable value to *our own* client bundle; neither can answer
 * a foreign protocol. Same exception, and same reasoning, as the download route.
 *
 * ## A free account, and why that is not a paywall
 *
 * The web pages, the download route and every trust surface stay anonymous — R8.1 is
 * untouched, and everything these tools return is readable in a browser by anyone. What
 * this endpoint requires is a **token**, because the limiter needs an identity to count
 * against and an anonymous protocol offers only an IP: shared behind a NAT, rotated by
 * anyone who cares, and therefore a bound on accidents rather than on abuse.
 *
 * A free account is the smallest thing that fixes that. It costs nothing, gates nothing a
 * person can read, and yields a credential that can be revoked — a quota identity, not a
 * paywall. RC.1's rule that trust surfaces cannot be gated is intact: every verdict returned
 * here is on a public page.
 *
 * The paid scope is absent rather than stubbed. It needs RC.1 entitlements in the DAL, and
 * a placeholder check *here* would be the one shape R8.8 rules out — an entitlement decision
 * living in the transport instead of below it.
 *
 * ## Rate limited before anything else runs
 *
 * `consume` is charged before the handler is reached, so a refused call costs one counter
 * upsert instead of a search across the corpus. Limits are admin-tunable settings, not
 * constants — see `server/settings/rate-limits.ts` for why that is not a nicety.
 *
 * ## Stateless
 *
 * `mcp-handler` v2 builds a fresh server per request and has no session store, so nothing
 * here needs Redis and nothing has to survive between invocations. That matches how every
 * other route in this app runs, and it is why the handler can be created once at module
 * scope and reused.
 */
const handler = createMcpHandler(
  (server) => {
    registerFreeTools(server);
  },
  {
    serverInfo: { name: "skills-foundry", version: "1.0.0" },
    // Local only for now; a deployed instance should stay quiet unless something failed.
    verboseLogs: process.env.NODE_ENV === "development",
  },
);

/**
 * HTTP 429 with a JSON-RPC error inside it.
 *
 * Both halves are needed and they address different readers. The status and `Retry-After`
 * are what a transport, proxy or SDK retry policy understands without parsing a body; the
 * JSON-RPC error is what the *model* sees, and it is the one that has to say in words that
 * this is a throttle rather than a refusal of permission.
 *
 * Error code −32000 is the JSON-RPC "implementation-defined server error" range. There is no
 * standard code for rate limiting, and inventing one outside the reserved range would be a
 * number no client can interpret either.
 */
function tooManyRequests(decision: Extract<Awaited<ReturnType<typeof consume>>, { allowed: false }>) {
  return Response.json(
    {
      jsonrpc: "2.0",
      // Null id: the body was never parsed, so the request's own id is unknown. The spec
      // provides for exactly this — guessing an id would answer a call nobody made.
      id: null,
      error: {
        code: -32000,
        message: decision.message,
        data: {
          window: decision.window,
          limit: decision.limit,
          reset_at: decision.resetAt.toISOString(),
          retry_after_seconds: decision.retryAfterSeconds,
          retryable: true,
        },
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Reset": String(Math.floor(decision.resetAt.getTime() / 1000)),
      },
    },
  );
}

/**
 * 401 with a JSON-RPC error inside, same two-audience reasoning as the 429.
 *
 * `WWW-Authenticate` is what a transport reads; the message is what the model reads, and it
 * has to name the fix. "Unauthorized" tells an agent nothing it can act on — where the token
 * comes from does.
 */
function unauthorized(message: string) {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message,
        data: { retryable: false, obtain_token_at: "/account" },
      },
    },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="skills-foundry"' } },
  );
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? rest.join(" ").trim() || undefined : undefined;
}

async function guarded(request: Request): Promise<Response> {
  /**
   * Order matters: authenticate, then charge.
   *
   * The limiter counts against the token, so it cannot run before the token is known —
   * and charging an unauthenticated caller would put us back to counting IPs, which is the
   * problem the token exists to solve. An unauthenticated request is refused after one
   * indexed lookup on a hash, which is cheaper than any tool call it was trying to make.
   */
  const principal = await resolveToken(bearer(request));
  if (!principal) {
    return unauthorized(
      "This endpoint needs an MCP access token. Create a free account, open Account → MCP " +
        "access, and send the token as `Authorization: Bearer sf_mcp_…`. A revoked or " +
        "unknown token gives this same answer.",
    );
  }

  // Everyone resolves to the free scope until RC.1 exists to say otherwise.
  const decision = await consume(request, "mcpFree", principal.rateKey);
  if (!decision.allowed) return tooManyRequests(decision);

  // After the limit, so a throttled caller does not keep its token looking busy — and not
  // awaited into the response path, because bookkeeping must never delay an answer.
  void touchToken(principal);

  return handler(request);
}

export { guarded as GET, guarded as POST };
