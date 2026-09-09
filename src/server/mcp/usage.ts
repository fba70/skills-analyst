import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { withExplicitOrgScope } from "@/server/dal/scope";
import { db } from "@/server/db";
import { events, mcpUsage } from "@/server/db/schema";

/**
 * MCP request accounting (Doc 2 RC.3's remaining half, plan step F1).
 *
 * `llm_usage` has metered every model call since RC.2, and MCP makes none — so what an agent
 * surface actually did has never been recorded anywhere readable. The only traces were a rate
 * limit window that resets and a `last_used_at` that overwrites.
 *
 * ## AsyncLocalStorage, and here it is available
 *
 * `send-failures.ts` reaches for a keyed module map and explains why it cannot use
 * AsyncLocalStorage: Better Auth owns that route, so there is nowhere to open a scope. **We own
 * this one.** `guarded` wraps the handler, the principal is resolved before dispatch, and the
 * tools run inside — so a real async scope is available and a module-level map, with all the
 * cross-request hazards that file documents, is not needed.
 *
 * The MCP handler is a module-level constant built once for every request, which is why the
 * principal cannot simply be passed as an argument to `registerFreeTools`.
 */

export type McpPrincipal = { tokenId: string; organizationId: string };

const store = new AsyncLocalStorage<McpPrincipal>();

/**
 * The principal for the request currently being served, or null outside one.
 *
 * Read by the write tool as well as the recorder, which is what lets the MCP handler stay a
 * single module-level constant: a tool that writes into one workspace needs to know which, and
 * the alternative was rebuilding the whole handler per request to close over it.
 */
export function currentMcpPrincipal(): McpPrincipal | null {
  return store.getStore() ?? null;
}

/** Open the scope for one request. Called by the route guard, around the handler. */
export function withMcpPrincipal<T>(principal: McpPrincipal, fn: () => Promise<T>): Promise<T> {
  return store.run(principal, fn);
}

/**
 * Count one tool call.
 *
 * **Never throws, and never delays the answer.** A reader must not get a 500 because an
 * accounting upsert hit a cold compute — the posture the heartbeat and `recordOutcome` both
 * take. That posture has cost this project once already: `recordUsage` swallowed an RLS refusal,
 * builder spend went unmetered for a milestone, and the only evidence was a log line.
 *
 * So the defence is not to remove the swallow. `verify:mcp-usage` writes **through this
 * function** and reads the row back, which is the only check that can tell a working recorder
 * from one that silently records nothing.
 */
export async function recordMcpCall(tool: string, outcome: "ok" | "error"): Promise<void> {
  const principal = store.getStore();
  if (!principal) return;
  const day = new Date().toISOString().slice(0, 10);

  try {
    await withExplicitOrgScope(principal.organizationId, async (tx) => {
      await tx
        .insert(mcpUsage)
        .values({
          orgId: principal.organizationId,
          tokenId: principal.tokenId,
          day,
          tool,
          calls: 1,
          errors: outcome === "error" ? 1 : 0,
        })
        /*
         * The count is the count. One row per (token, day, tool) incremented in place means
         * there is no second place to update and no application logic a later call site could
         * forget — the property `outcome_signals` gets from its dedup index.
         */
        .onConflictDoUpdate({
          target: [mcpUsage.tokenId, mcpUsage.day, mcpUsage.tool],
          set: {
            calls: sql`${mcpUsage.calls} + 1`,
            errors: sql`${mcpUsage.errors} + ${outcome === "error" ? 1 : 0}`,
            lastAt: new Date(),
          },
        });
    });
  } catch (error) {
    console.error("[mcp-usage] failed to record", error);
  }
}

/**
 * Record a refusal, which has no tool to be counted against.
 *
 * The rate limiter runs in the route guard, before any tool is chosen, so a counter row would
 * need a sentinel in the `tool` column — a value the next `group by` would believe. It is also
 * the *exceptional* event, and detail on the rare thing is what `events` is for: which window,
 * which limit, when it lifts. Successes are countable; failures are investigable.
 */
export async function recordMcpRefusal(input: {
  organizationId: string;
  tokenId: string;
  window: string;
  limit: number;
  retryAfterSeconds: number;
}): Promise<void> {
  try {
    await withExplicitOrgScope(input.organizationId, async (tx) => {
      await tx.insert(events).values({
        orgId: input.organizationId,
        actorType: "system",
        actorId: "mcp",
        kind: "mcp.throttled",
        subjectType: "mcp_tokens",
        subjectId: input.tokenId,
        payload: {
          window: input.window,
          limit: input.limit,
          retryAfterSeconds: input.retryAfterSeconds,
        },
      });
    });
  } catch (error) {
    console.error("[mcp-usage] failed to record a refusal", error);
  }
}

export type McpUsageRow = {
  tokenId: string;
  prefix: string | null;
  orgName: string | null;
  tool: string;
  calls: number;
  errors: number;
  lastAt: Date;
};

/**
 * What every token did over a window, for the operator panel.
 *
 * Reads across organisations, which is what the open SELECT policy is for and why the column
 * list is worth re-reading before adding to it: a token prefix, a workspace name, a tool name
 * and two integers. Nothing here says what was asked for.
 */
export async function mcpUsageSince(days = 30): Promise<McpUsageRow[]> {
  const { rows } = await db.execute<{
    token_id: string;
    prefix: string | null;
    org_name: string | null;
    tool: string;
    calls: number;
    errors: number;
    last_at: Date;
  }>(sql`
    select u.token_id, t.prefix, o.name as org_name, u.tool,
           sum(u.calls)::int as calls, sum(u.errors)::int as errors, max(u.last_at) as last_at
      from mcp_usage u
      left join mcp_tokens t on t.id = u.token_id
      left join organization o on o.id = u.org_id
     where u.day >= (current_date - ${days}::int)
     group by u.token_id, t.prefix, o.name, u.tool
     order by sum(u.calls) desc
     limit 200
  `);
  return rows.map((row) => ({
    tokenId: row.token_id,
    prefix: row.prefix,
    orgName: row.org_name,
    tool: row.tool,
    calls: row.calls,
    errors: row.errors,
    lastAt: row.last_at,
  }));
}

/** Headline counts for the Spend panel: the totals, and how far back the record goes. */
export async function mcpUsageSummary() {
  const { rows } = await db.execute<{
    calls: number;
    errors: number;
    tokens: number;
    tools: number;
    since: string | null;
  }>(sql`
    select coalesce(sum(calls), 0)::int as calls,
           coalesce(sum(errors), 0)::int as errors,
           count(distinct token_id)::int as tokens,
           count(distinct tool)::int as tools,
           min(day)::text as since
      from mcp_usage
  `);
  const { rows: throttled } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from events where kind = 'mcp.throttled'
  `);
  return {
    ...(rows[0] ?? { calls: 0, errors: 0, tokens: 0, tools: 0, since: null }),
    throttled: throttled[0]?.n ?? 0,
  };
}
