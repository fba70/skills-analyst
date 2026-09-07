import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OUTCOME_META, type OutcomeKind } from "@/lib/outcomes";
import type {
  ArchetypeActivity,
  LoopEvent,
  LoopMetrics,
} from "@/server/analytics/loop";
import { MIN_SESSIONS_FOR_TREND, STALL_SIGNAL_THRESHOLD } from "@/server/analytics/loop";

/**
 * The loop, observable (Doc 2 R6.4).
 *
 * Ingest → validate → analyze → build → publish → learn now runs. This is the page that
 * says whether it is *still* running, which is a different question and the one that stops
 * being asked once everything works.
 *
 * The stall table is the part worth reading. Everything else here is a number going up.
 */
export type OutcomeRow = { kind: string; n: number };
export type OutcomeTotals = {
  signals: number;
  skills: number;
  attributed: number;
  days: number;
};

export function LoopPanel({
  metrics,
  activity,
  events,
  outcomes,
  outcomeTotals,
  outcomeEligible,
  unimplementedKinds,
}: {
  metrics: LoopMetrics;
  activity: ArchetypeActivity[];
  events: LoopEvent[];
  outcomes: OutcomeRow[];
  outcomeTotals: OutcomeTotals;
  outcomeEligible: number;
  unimplementedKinds: readonly string[];
}) {
  const stalled = activity.filter((row) => row.stalled);

  return (
    <div className="grid gap-4">
      <OutcomeCard
        rows={outcomes}
        totals={outcomeTotals}
        eligible={outcomeEligible}
        unimplemented={unimplementedKinds}
      />
      {stalled.length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="text-destructive size-4" />
              The loop has stalled in {stalled.length} categor
              {stalled.length === 1 ? "y" : "ies"}
            </CardTitle>
            <CardDescription>
              Authoring signal is arriving and no archetype has been re-mined to consume it.
              Nothing errors when this happens — mining is a manual command, so a category
              can accumulate feedback for weeks while its guidance stays where it was.
              <br />
              Run <code className="text-xs">pnpm archetypes --mine-all</code>. It is free.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Sessions"
          value={metrics.sessions}
          detail="authored and published"
        />
        <Metric
          label="Unconsumed"
          value={activity.reduce((sum, row) => sum + row.signalsSince, 0)}
          detail="signals since the last mine"
        />
        <Metric
          label="First-pass valid"
          value={metrics.firstPassRate === null ? "—" : `${metrics.firstPassRate}%`}
          detail="G3 target: 80%"
          good={metrics.firstPassRate !== null && metrics.firstPassRate >= 80}
        />
        <Metric
          label="Used a suggestion"
          value={metrics.suggestionUseRate === null ? "—" : `${metrics.suggestionUseRate}%`}
          detail="G4 target: 60%"
          good={metrics.suggestionUseRate !== null && metrics.suggestionUseRate >= 60}
        />
      </div>

      {metrics.thin ? (
        /*
         * Said plainly rather than shown as a confident percentage.
         *
         * A share over a handful of drafts is one draft's opinion expressed to two
         * significant figures, and G3/G4 are targets someone will eventually report against.
         * Marking the sample as thin is the difference between a metric and a claim.
         */
        <p className="text-muted-foreground text-xs">
          {metrics.sessions} published session
          {metrics.sessions === 1 ? "" : "s"} — below the {MIN_SESSIONS_FOR_TREND}{" "}
          needed before these rates read as a trend rather than as a single session.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Archetypes, and what has arrived since</CardTitle>
          <CardDescription>
            Each category&rsquo;s current version with the changelog that explains it, and the
            authoring signal recorded after it was mined. {STALL_SIGNAL_THRESHOLD} or more
            unconsumed signals is a stall.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3">
            {activity.map((row) => (
              <li key={row.category} className="grid gap-1">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-medium">{row.label}</span>
                  <Badge variant="outline" className="text-[11px]">
                    v{row.version}
                  </Badge>
                  {row.stalled ? (
                    <Badge variant="destructive" className="text-[11px]">
                      {row.signalsSince} unconsumed
                    </Badge>
                  ) : row.signalsSince > 0 ? (
                    <Badge variant="secondary" className="text-[11px]">
                      {row.signalsSince} since
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground ml-auto text-xs">
                    {row.minedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                  </span>
                </div>
                {row.changelog ? (
                  <p className="text-muted-foreground text-xs">{row.changelog}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent loop activity</CardTitle>
          <CardDescription>
            Read from the audit log the loop already writes (R7.1) rather than from a second
            record that could disagree with it. Platform-scoped events only — a workspace&rsquo;s
            own publications belong to that workspace, not to this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="grid gap-1.5">
              {events.map((event, index) => (
                <li key={index} className="grid gap-0.5 text-sm sm:flex sm:gap-3">
                  <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-44">
                    {event.at.toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    {event.kind.replace(/^(builder|archetype|spend)\./, "")}
                  </span>
                  <span className="text-muted-foreground min-w-0 text-xs">{event.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  good,
}: {
  label: string;
  value: number | string;
  detail?: string;
  good?: boolean;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
        <span className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
          {typeof value === "number" ? value.toLocaleString() : value}
          {good ? <CheckCircle2 className="text-primary size-4" /> : null}
        </span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The other half of the loop (R6.3).
 *
 * ## Two numbers, and the second is the honest caveat
 *
 * Signals collected, and how many carry **archetype lineage**. Only skills published through
 * the builder were scaffolded from an archetype, so the second number is near zero and stays
 * there until builder volume grows. Reporting the first without the second is how "the loop
 * is closed" becomes a claim nobody checked: thousands of downloads attributing to nothing
 * and changing no guidance.
 *
 * So the card leads with collection, states attribution beside it, and says plainly that the
 * miner is not consuming any of it yet.
 */
function OutcomeCard({
  rows,
  totals,
  eligible,
  unimplemented,
}: {
  rows: OutcomeRow[];
  totals: OutcomeTotals;
  eligible: number;
  unimplemented: readonly string[];
}) {
  const coverage = eligible > 0 ? (totals.skills / eligible) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Outcome telemetry (R6.3)</CardTitle>
        <CardDescription>
          What happened to skills after publication — downloads, whether they held up under
          re-validation, whether anyone withdrew or deprecated them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {totals.signals === 0 ? (
          /*
           * An empty state that says which kind of empty it is. The pipeline is wired and
           * nothing has been downloaded or re-validated yet, which is a different thing from
           * "collection is broken" — and a bare zero cannot tell those apart.
           */
          <p className="text-muted-foreground text-sm">
            No signals yet. Collection is wired into the download route, the MCP download
            tool, re-validation and lifecycle declarations — this fills in as those happen.
          </p>
        ) : (
          <>
            <div className="grid gap-1.5">
              {rows.map((row) => (
                <div key={row.kind} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{OUTCOME_META[row.kind as OutcomeKind]?.label ?? row.kind}</span>
                  <span className="text-muted-foreground tabular-nums">{row.n}</span>
                </div>
              ))}
            </div>
            <div className="text-muted-foreground grid gap-0.5 text-xs">
              <span>
                {totals.skills} of {eligible} skills have any signal ({coverage.toFixed(1)}%),
                across {totals.days} day{totals.days === 1 ? "" : "s"}
              </span>
              <span>
                <strong>{totals.attributed}</strong> of {totals.signals} carry archetype
                lineage — only skills authored here have any, so R6.3&rsquo;s attribution half
                stays thin until builder volume grows
              </span>
            </div>
          </>
        )}

        <p className="text-muted-foreground/80 text-xs">
          Not collected yet: {unimplemented.join(", ")}. Flagging needs a reader route (R2.5);
          eval deltas need the Eval Lab. Nothing here feeds archetype mining yet — wiring a
          near-empty input into the thing that scaffolds every future draft is how a loop
          poisons itself with its own noise.
        </p>
      </CardContent>
    </Card>
  );
}
