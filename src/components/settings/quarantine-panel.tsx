"use client";

import { useState, useTransition } from "react";
import { ShieldAlert, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { releaseAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { QuarantinedVersion } from "@/server/dal/curation";

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
 */
export function QuarantinePanel({ versions }: { versions: QuarantinedVersion[] }) {
  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center text-sm">
          Nothing in quarantine.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        {versions.length} version{versions.length === 1 ? "" : "s"} failed validation and
        are invisible in the registry. Releasing one keeps the original verdicts as history.
      </p>
      {versions.map((version) => (
        <QuarantineCard key={version.versionId} version={version} />
      ))}
    </div>
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
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this a false positive?"
              className="h-9 max-w-sm"
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
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
