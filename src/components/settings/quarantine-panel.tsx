"use client";

import { useState, useTransition } from "react";
import { ShieldAlert, ShieldCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { confirmQuarantineAction, releaseAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { QuarantinedVersion } from "@/server/dal/curation";
import type { QuarantinePrecision } from "@/server/analytics/precision";

/**
 * The quarantine queue — the appeal path, and the precision measurement.
 *
 * Doc 3 makes quarantine precision a stage gate (≥90% upheld on spot-check): a pipeline
 * that quarantines noisily erodes trust faster than one that misses things. This queue is
 * how that number gets produced, so every entry shows the evidence rather than just the
 * verdict.
 *
 * Releasing does not edit the original verdicts. It records a curator override that
 * supersedes them, so a later false-negative postmortem can still see what the analyzer
 * found and who decided otherwise.
 *
 * **Both answers are now recordable, and that is what makes the gate measurable.** Until
 * `confirmQuarantine` existed, agreeing with the analyzer wrote nothing — so "reviewed and
 * correct" and "nobody has opened this" were the same silence, and the best number anyone
 * could compute was a lower bound that reads highest when nobody is checking.
 */
export function QuarantinePanel({
  versions,
  precision,
}: {
  versions: QuarantinedVersion[];
  precision: QuarantinePrecision;
}) {
  return (
    <div className="grid gap-3">
      <PrecisionCard precision={precision} />
      {versions.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            Nothing in quarantine.
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {versions.length} version{versions.length === 1 ? "" : "s"} failed validation and
            are invisible in the registry. Both decisions are kept: releasing records a
            curator override, confirming records that a person looked and the quarantine
            stands. The original verdicts are never edited.
          </p>
          {versions.map((version) => (
            <QuarantineCard key={version.versionId} version={version} />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The gate, with its denominator.
 *
 * *94% over 31 of 1,053* and *94% over 31 of 31* are the same percentage and different
 * claims, so the coverage is never separated from the number. Below the minimum sample the
 * figure is withheld rather than greyed out: a muted number is still a number somebody will
 * quote, and a percentage over four spot-checks is one curator's morning.
 */
function PrecisionCard({ precision }: { precision: QuarantinePrecision }) {
  const tone =
    precision.meets === null
      ? "text-muted-foreground"
      : precision.meets
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-destructive";

  return (
    <Card>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium">Quarantine precision</span>
          <span className={`text-2xl font-semibold tabular-nums ${tone}`}>
            {precision.precision === null ? "—" : `${precision.precision}%`}
          </span>
          <span className="text-muted-foreground text-xs">
            target {precision.target}% · Doc 3 stage gate
          </span>
        </div>

        <p className="text-muted-foreground text-sm">
          {precision.absentReason ? (
            <>Not measured yet — {precision.absentReason}. </>
          ) : (
            <>
              {precision.upheld} of {precision.reviewed} spot-checks upheld,{" "}
              {precision.released} released.{" "}
            </>
          )}
          {precision.everQuarantined > 0 ? (
            <>
              {precision.reviewed} of {precision.everQuarantined.toLocaleString()} versions
              ever quarantined have been reviewed
              {precision.coverage === null ? "" : ` (${precision.coverage}%)`}, and{" "}
              {precision.quarantined.toLocaleString()} are in the queue now.
            </>
          ) : null}
        </p>

        <p className="text-muted-foreground/80 text-xs">
          Measured over what was reviewed, never over the queue — a gate denominated in
          1,000 versions nobody can read by hand could not be cleared by any amount of work.
          The public corpus only: a workspace&rsquo;s own quarantines are not a platform
          property.
        </p>
      </CardContent>
    </Card>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  high: "border-destructive/40 bg-destructive/10 text-destructive",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function QuarantineCard({ version }: { version: QuarantinedVersion }) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [released, setReleased] = useState(false);
  const [reviewed, setReviewed] = useState(version.reviewed);

  function release() {
    startTransition(async () => {
      const result = await releaseAction(version.versionId, reason);
      if (result.ok) {
        setReleased(true);
        toast.success(version.name, { description: result.message });
      } else {
        toast.error(version.name, { description: result.message });
      }
    });
  }

  function confirm() {
    startTransition(async () => {
      const result = await confirmQuarantineAction(version.versionId, reason);
      if (result.ok) {
        setReviewed(true);
        toast.success(version.name, { description: result.message });
      } else {
        toast.error(version.name, { description: result.message });
      }
    });
  }

  return (
    <Card className={released ? "opacity-60" : undefined}>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldAlert className="text-destructive size-4" />
          <span className="font-medium">{version.name}</span>
          <span className="text-muted-foreground text-xs">{version.sourceName}</span>
          {released ? (
            <Badge variant="secondary" className="text-xs">
              released
            </Badge>
          ) : reviewed ? (
            <Badge variant="outline" className="text-xs">
              spot-checked
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1">
          {(version.reasons ?? []).map((reasonCode) => (
            <Badge key={reasonCode} variant="outline" className="font-mono text-[11px]">
              {reasonCode}
            </Badge>
          ))}
        </div>

        {version.findings.length > 0 ? (
          <ul className="grid gap-1.5 text-sm">
            {version.findings.slice(0, 6).map((finding, index) => (
              <li key={`${finding.reason}-${index}`} className="grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`text-[11px] ${SEVERITY_TONE[finding.severity] ?? ""}`}
                  >
                    {finding.severity}
                  </Badge>
                  <code className="text-xs">{finding.reason}</code>
                  {finding.file ? (
                    <span className="text-muted-foreground text-xs">
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground">{finding.message}</p>
              </li>
            ))}
          </ul>
        ) : null}

        {!released ? (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="What did you decide, and why?"
                className="h-9 max-w-sm min-w-0"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={isPending || reason.trim().length === 0}
                onClick={release}
              >
                <Undo2 className="size-4" />
                Release
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending || reviewed || reason.trim().length === 0}
                onClick={confirm}
              >
                <ShieldCheck className="size-4" />
                {reviewed ? "Confirmed" : "Confirm"}
              </Button>
            </div>
            <p className="text-muted-foreground/80 text-xs">
              Confirming leaves it in quarantine and counts towards the precision gate. Both
              answers need a reason: a spot-check with no note is not evidence.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
