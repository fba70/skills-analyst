import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
export function LoopPanel({
  metrics,
  activity,
  events,
}: {
  metrics: LoopMetrics;
  activity: ArchetypeActivity[];
  events: LoopEvent[];
}) {
  const stalled = activity.filter((row) => row.stalled);

  return (
    <div className="grid gap-4">
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
