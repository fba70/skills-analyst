import { CircleAlert, CircleCheck, CircleSlash, CircleHelp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SourceHealth } from "@/server/dal/curation";

/**
 * Per-source health.
 *
 * Doc 3 puts this first among the dashboards for one reason: "starvation must be visible,
 * not silent". A source that quietly stops producing looks identical to a source with
 * nothing new, and the difference only shows if last-sync and last-*success* are both on
 * screen.
 */
const HEALTH = {
  healthy: { icon: CircleCheck, tone: "text-primary" },
  degraded: { icon: CircleAlert, tone: "text-amber-600 dark:text-amber-400" },
  failing: { icon: CircleAlert, tone: "text-destructive" },
  paused: { icon: CircleSlash, tone: "text-muted-foreground" },
  unknown: { icon: CircleHelp, tone: "text-muted-foreground" },
} as const;

/** Hours come from the database, so nothing here reads the clock during render. */
function ago(hours: number | null): string {
  if (hours === null || Number.isNaN(hours)) return "never";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SourcesPanel({
  sources,
  total,
  stale,
  disabled,
}: {
  sources: SourceHealth[];
  /** Whole-table counts: "0 stale" must mean zero everywhere, not zero on this page. */
  total: number;
  stale: number;
  disabled: number;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        {total} source{total === 1 ? "" : "s"} · {disabled} disabled ·{" "}
        {/* R7.4 sets corpus staleness at 24h; showing it here is what makes it actionable. */}
        <span className={stale > 0 ? "text-amber-600 dark:text-amber-400" : undefined}>
          {stale} without a successful sync in 24h
        </span>
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Health</TableHead>
              <TableHead className="hidden sm:table-cell">Skills</TableHead>
              <TableHead className="hidden md:table-cell">Last attempt</TableHead>
              <TableHead>Last success</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => {
              const meta = HEALTH[source.health as keyof typeof HEALTH] ?? HEALTH.unknown;
              const Icon = meta.icon;
              return (
                <TableRow key={source.id} className={source.enabled ? undefined : "opacity-60"}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{source.name}</span>
                      {source.detail ? (
                        <span className="text-muted-foreground text-xs">{source.detail}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-sm">
                      <Icon className={`size-4 ${meta.tone}`} />
                      {source.health}
                      {!source.enabled ? (
                        <Badge variant="outline" className="text-[11px]">
                          disabled
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell tabular-nums">
                    {source.skills}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                    {ago(source.hoursSinceAttempt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {ago(source.hoursSinceSuccess)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
