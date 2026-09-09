import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

/**
 * An MCP token's usage is recorded, and cannot say what was asked for (Doc 2 RC.3, plan step F1).
 *
 *   pnpm verify:mcp-usage
 *
 * Free. It writes through the real recorder against the real table and removes the rows in a
 * `finally`.
 *
 * ## The two properties this file exists to protect
 *
 * 1. **The recorder actually records.** It swallows its own failures on purpose — a reader must
 *    not get a 500 because an accounting upsert hit a cold compute — and this project has already
 *    paid for that posture once: `recordUsage` swallowed an RLS refusal, builder spend went
 *    unmetered for a milestone, and the only evidence was a log line nobody read. A hand-written
 *    insert would prove the table works and nothing about whether the function meant to fill it
 *    does. So the suite calls `recordMcpCall` and reads the row back.
 * 2. **It cannot reconstruct what was searched for.** A per-request log keyed by token would
 *    answer *"what did this customer search for"* — the question `search_queries` was built to be
 *    unable to answer, with no `org_id` to join and a rotating digest instead of an identity.
 *    Checked against `information_schema`, because clean data says nothing about the next
 *    migration.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nRecording is wired once, not per tool");

const tools = readFileSync(join(process.cwd(), "src/server/mcp/tools.ts"), "utf8");
check(
  "every tool registers through the counting wrapper",
  tools.split("\n  register(").length - 1 === 6 && !/\n  server\.registerTool\(/.test(tools),
  `${tools.split("\n  register(").length - 1} tools`,
);
check(
  "a tool that throws is counted as an error rather than as a call",
  /recordMcpCall\(name, "error"\)/.test(tools) && /recordMcpCall\(name, "ok"\)/.test(tools),
  "our outage is not the caller's usage",
);

const routeRaw = readFileSync(join(process.cwd(), "src/app/api/mcp/route.ts"), "utf8");
/*
 * Comments stripped before scanning, and this is the third time that has been necessary.
 *
 * The route's own header says *"this file touches no `@/server/db`, no `drizzle-orm`, no `pg`"* —
 * so a naive scan for those names finds the sentence promising they are absent and reports the
 * rule as broken. `verify:relations` hit it hunting `= any(${array})` and `verify:improve` hit it
 * hunting duplicate licence lists. A scanner that reads prose is a scanner that shouts loudest
 * where the problem is least.
 */
const route = routeRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check(
  "the route opens the async scope the recorder reads from",
  /withMcpPrincipal\(/.test(route),
);
check(
  "a refusal is an events row, not a counter with a sentinel tool",
  /recordMcpRefusal\(/.test(route) && !/tool: ?"[*_(]/.test(route),
  "the limiter runs before a tool is chosen, so there is nothing to count it against",
);
check(
  "the route still touches no database module directly",
  !/@\/server\/db\b|drizzle-orm|from "pg"/.test(route),
  "hard rule 5 — queries live in src/server and are called from here",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the source checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.mcp_usage') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — the migration is not applied yet");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'mcp_usage'`,
    );
    const names = columns.map((col) => col.column_name);
    check(
      "no column can hold what was asked for",
      names.every((name) =>
        ["id", "org_id", "token_id", "day", "tool", "calls", "errors", "last_at"].includes(name),
      ),
      names.join(", "),
    );
    check(
      "the unit is a day, not a request",
      names.includes("day") && !names.includes("at") && !names.includes("request_id"),
      "a per-request log keyed by token would undo the search_queries decision through a side door",
    );

    const { rows: policies } = await c.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename = 'mcp_usage'`,
    );
    check(
      "the split policy: read across organisations, write only your own",
      policies.some((p) => p.cmd === "SELECT") &&
        policies.some((p) => p.cmd === "INSERT") &&
        policies.some((p) => p.cmd === "UPDATE"),
      policies.map((p) => p.cmd).join(", "),
    );
    check(
      "and no DELETE policy, so a workspace cannot erase its own usage",
      !policies.some((p) => p.cmd === "DELETE"),
      "the same argument llm_usage makes about an application that can delete its own charges",
    );

    const { rows: token } = await c.query<{ id: string; org_id: string }>(
      `select id, org_id from mcp_tokens limit 1`,
    );
    if (token.length === 0) {
      console.info("  skip  no MCP token to record against — create one at /account/mcp");
    } else {
      const { recordMcpCall, withMcpPrincipal, mcpUsageSummary } = await import(
        "../src/server/mcp/usage"
      );
      const principal = { tokenId: token[0].id, organizationId: token[0].org_id };
      const probeTool = "verify_probe_tool";

      try {
        /*
         * Through the real recorder, inside a real async scope. The whole point: a
         * swallow-everything function can only be shown to work by reading back what it wrote.
         */
        await withMcpPrincipal(principal, async () => {
          await recordMcpCall(probeTool, "ok");
        });

        const { rows: after } = await c.query<{ calls: number; errors: number }>(
          `select calls, errors from mcp_usage where token_id = $1 and tool = $2`,
          [principal.tokenId, probeTool],
        );
        check(
          "the recorder writes a row RLS accepts",
          after.length === 1 && after[0].calls === 1,
          after.length === 0 ? "nothing was written" : `calls=${after[0].calls}`,
        );

        await withMcpPrincipal(principal, async () => {
          await recordMcpCall(probeTool, "ok");
          await recordMcpCall(probeTool, "error");
        });
        const { rows: incremented } = await c.query<{ n: string; calls: number; errors: number }>(
          `select count(*)::text as n, max(calls) as calls, max(errors) as errors
             from mcp_usage where token_id = $1 and tool = $2`,
          [principal.tokenId, probeTool],
        );
        check(
          "three calls are one row, incremented",
          incremented[0].n === "1" && incremented[0].calls === 3,
          `${incremented[0].n} row(s), calls=${incremented[0].calls}`,
        );
        check(
          "and an error is counted apart from the call it also was",
          incremented[0].errors === 1,
          `errors=${incremented[0].errors}`,
        );

        /*
         * Outside the scope there is no principal, and the recorder must do nothing rather than
         * guess one. A default org here would attribute one workspace's usage to another.
         */
        await recordMcpCall("verify_probe_unscoped", "ok");
        const { rows: unscoped } = await c.query<{ n: string }>(
          `select count(*)::text as n from mcp_usage where tool = 'verify_probe_unscoped'`,
        );
        check(
          "outside a request scope it records nothing rather than guessing an owner",
          unscoped[0].n === "0",
        );

        const summary = await mcpUsageSummary();
        check(
          "the summary reads back what was recorded",
          summary.calls >= 3 && summary.tokens >= 1,
          `${summary.calls} call(s) across ${summary.tokens} token(s) since ${summary.since}`,
        );
      } finally {
        await c.query(`delete from mcp_usage where tool like 'verify_probe_%'`);
        const { rows: left } = await c.query<{ n: string }>(
          `select count(*)::text as n from mcp_usage where tool like 'verify_probe_%'`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
