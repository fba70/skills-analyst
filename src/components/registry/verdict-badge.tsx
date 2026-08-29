import { AlertTriangle, CircleAlert, CircleCheck, CircleX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The verdict surface.
 *
 * Free-tier trust surfaces are hard-coded exempt from gating (Doc 2 RC.1) — a verdict is
 * never behind a paywall and never behind a feature flag, so these components take no
 * entitlement props at all. There is no code path here that can hide a failure.
 */

const STYLES = {
  pass: { icon: CircleCheck, label: "Pass", className: "text-primary border-primary/40 bg-primary/10" },
  warn: { icon: AlertTriangle, label: "Warnings", className: "text-amber-600 border-amber-500/40 bg-amber-500/10 dark:text-amber-400" },
  fail: { icon: CircleX, label: "Failed", className: "text-destructive border-destructive/40 bg-destructive/10" },
  error: { icon: CircleAlert, label: "Analyzer error", className: "text-destructive border-destructive/40 bg-destructive/10" },
} as const;

export type VerdictResult = keyof typeof STYLES;

export function VerdictBadge({
  result,
  label,
  className,
}: {
  result: VerdictResult;
  label?: string;
  className?: string;
}) {
  const style = STYLES[result] ?? STYLES.error;
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", style.className, className)}>
      <Icon className="size-3.5" />
      {label ?? style.label}
    </Badge>
  );
}

/** Overall standing: quarantined if anything blocks, otherwise the worst non-pass. */
export function OverallVerdict({
  verdicts,
  status,
}: {
  verdicts: Array<{ result: string }>;
  status: string;
}) {
  if (status === "quarantined") return <VerdictBadge result="fail" label="Quarantined" />;
  const hasWarn = verdicts.some((verdict) => verdict.result === "warn");
  return (
    <VerdictBadge
      result={hasWarn ? "warn" : "pass"}
      label={hasWarn ? "Passed with warnings" : "Passed all checks"}
    />
  );
}
