import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMicros } from "@/lib/llm-pricing";
import type { BudgetState } from "@/server/billing/spend";

/**
 * What the platform is spending, and how close it is to stopping (Doc 2 RC.2).
 *
 * RC.2 asks for a global platform budget "with alerting". The alert itself is an `events`
 * row written on the crossing — this is the standing view, because an alert tells you the
 * moment something changed and a panel tells you where things stand. An operator who only
 * ever learns about spend from an alert learns about it once, at 80%.
 *
 * Server component: three aggregates, nothing interactive.
 */
export function SpendPanel({
  platform,
  breakdown,
  mcp,
}: {
  platform: BudgetState;
  breakdown: Array<{ purpose: string; calls: number; costMicros: number }>;
  /**
   * MCP request accounting (RC.3's other half, plan step F1).
   *
   * It sits on this panel rather than a tab of its own because it is the same question the rest
   * of the panel answers — *what is being used* — asked of the one surface the spend ledger
   * cannot see, because MCP makes no model calls and therefore costs nothing to meter.
   */
  mcp: {
    calls: number;
    errors: number;
    tokens: number;
    tools: number;
    since: string | null;
    throttled: number;
  } | null;
}) {
  const orgTotal = breakdown
    .filter((row) => row.purpose === "builder" || row.purpose === "validation")
    .reduce((sum, row) => sum + row.costMicros, 0);

  return (
    <div className="grid gap-4">
      <Card className={platform.remainingMicros <= 0 ? "border-destructive/40" : undefined}>
        <CardHeader>
          <CardTitle className="text-base">Platform analysis budget</CardTitle>
          <CardDescription>
            Corpus taxonomy and corpus validation. Separate from customer allowances on
            purpose — a busy month of authoring must not stop the corpus being analysed, and
            a corpus run must not spend a customer&rsquo;s budget.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {formatMicros(platform.spentMicros)}
            </span>
            <span className="text-muted-foreground text-sm">
              of {formatMicros(platform.capMicros)} this month · resets{" "}
              {platform.resetsAt.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className={`h-full rounded-full ${
                platform.usedPercent >= 100
                  ? "bg-destructive"
                  : platform.usedPercent >= 80
                    ? "bg-amber-500"
                    : "bg-primary"
              }`}
              style={{ width: `${platform.usedPercent}%` }}
            />
          </div>
          {platform.remainingMicros <= 0 ? (
            <p className="text-destructive text-sm">
              Corpus analysis is refused until the budget resets. Raise
              <code className="mx-1 text-xs">LLM_PLATFORM_MONTHLY_CAP_USD</code>
              to continue sooner.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">This month, by purpose</CardTitle>
          <CardDescription>
            Every model call is metered into an append-only ledger (RC.3), so a bill is
            reconstructible rather than reported. The ledger has no delete path — not even
            for the application.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {breakdown.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing spent this month.</p>
          ) : (
            <ul className="grid gap-2">
              {breakdown
                .slice()
                .sort((a, b) => b.costMicros - a.costMicros)
                .map((row) => (
                  <li
                    key={row.purpose}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                  >
                    <span>{row.purpose.replace(/_/g, " ")}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {row.calls.toLocaleString()} call{row.calls === 1 ? "" : "s"} ·{" "}
                      {formatMicros(row.costMicros)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          {orgTotal > 0 ? (
            <p className="text-muted-foreground border-t pt-3 text-xs">
              {formatMicros(orgTotal)} of that is customer work, billed against per-workspace
              caps rather than the platform budget.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/*
        RC.3's other half (plan step F1).

        The ledger above prices model calls; MCP makes none, so it has always been invisible here.
        This is what the agent surface actually did — and the sentence about what it cannot say is
        as much a part of the panel as the numbers, because somebody will eventually ask.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent surface (MCP)</CardTitle>
          <CardDescription>
            MCP makes no model calls, so it costs nothing and the ledger above cannot see it. This
            is the request record instead — counted per token, per tool, per day.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!mcp || mcp.calls === 0 ? (
            <p className="text-muted-foreground text-sm">
              {mcp === null
                ? "Not loaded."
                : "No tool calls recorded yet. Recording began with the accounting table, so a token used before then has no history — that is a gap in the record, not a quiet token."}
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Figure label="Tool calls" value={mcp.calls} />
                <Figure label="Tokens active" value={mcp.tokens} />
                <Figure label="Tools used" value={mcp.tools} />
                <Figure label="Errors" value={mcp.errors} />
              </div>
              <p className="text-muted-foreground border-t pt-3 text-xs">
                Since {mcp.since ?? "—"} · {mcp.throttled.toLocaleString()} request
                {mcp.throttled === 1 ? "" : "s"} refused by the rate limiter, recorded as events
                rather than counted here.{" "}
                <strong>
                  This record cannot say what was searched for or which skill was fetched
                </strong>{" "}
                — a per-request log keyed by token would answer that, which is the question the
                search-query table is deliberately built to be unable to answer.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
