"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { saveRateLimitsAction, type ActionResult } from "@/app/(protected)/settings/actions";
import type { RateLimitSettings, ScopeLimits } from "@/server/settings/rate-limits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The MCP rate limits, as an operator control (Doc 2 R8.8).
 *
 * The second instalment of "policy becomes data", and the one with the sharpest reason for
 * it: the moment you need to change a rate limit is the moment something is hammering the
 * endpoint, which is exactly when waiting for a deploy is unaffordable.
 *
 * The panel is honest about two things it would be easy to imply otherwise:
 *
 *   - **the paid row is stored and not in effect.** There are no entitlements (RC.1), so
 *     every caller resolves to the free scope. A control that silently does nothing is
 *     worse than an absent one, so it says so on the card rather than in a tooltip;
 *   - **the identity is an IP**, which is shared behind a NAT and trivially rotated. This
 *     bounds accidents, not adversaries, and an operator reading a limit of 60 should know
 *     what the 60 is counted against before they trust it.
 */
export function RateLimitPanel({ limits }: { limits: RateLimitSettings }) {
  const [draft, setDraft] = useState<RateLimitSettings>(limits);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(limits);

  function save() {
    startTransition(async () => {
      const outcome = await saveRateLimitsAction(draft);
      setResult(outcome);
      if (outcome.ok) toast.success("Rate limits", { description: outcome.message });
      else toast.error("Rate limits", { description: outcome.message });
    });
  }

  return (
    <div className="grid gap-4">
      <ScopeCard
        title="MCP — free scope"
        description="Anonymous callers of /api/mcp. Counted per IP address, which is shared behind a NAT and trivially rotated: this bounds a runaway agent loop, not a determined caller."
        badge="in effect"
        badgeVariant="default"
        scope={draft.mcpFree}
        onChange={(next) => setDraft({ ...draft, mcpFree: { ...draft.mcpFree, ...next } })}
      />

      <ScopeCard
        title="MCP — paid scope"
        description="Authenticated, entitled callers. Stored and applied by the same code path, but nothing reaches it yet: entitlements (RC.1) do not exist, so every caller today resolves to the free scope above."
        badge="not reachable yet"
        badgeVariant="outline"
        scope={draft.mcpPaid}
        onChange={(next) => setDraft({ ...draft, mcpPaid: { ...draft.mcpPaid, ...next } })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={!dirty || isPending}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save limits
        </Button>
        <span className="text-muted-foreground text-xs">
          A refused call is told which window it hit and when it lifts, so a caller can tell a
          throttle from a permission failure. Every change is recorded in the audit log.
        </span>
        {result && !result.ok ? (
          <span className="text-destructive text-xs">{result.message}</span>
        ) : null}
      </div>
    </div>
  );
}

function ScopeCard({
  title,
  description,
  badge,
  badgeVariant,
  scope,
  onChange,
}: {
  title: string;
  description: string;
  badge: string;
  badgeVariant: "default" | "outline";
  scope: ScopeLimits;
  onChange: (next: Partial<ScopeLimits>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {title}
          <Badge variant={badgeVariant}>{badge}</Badge>
          <Badge variant={scope.enabled ? "secondary" : "outline"}>
            {scope.enabled ? "limited" : "unlimited"}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary size-4"
            checked={scope.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          Enforce a limit
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id={`${title}-minute`}
            label="Requests per minute"
            hint="Stops a tight loop."
            value={scope.perMinute}
            onChange={(perMinute) => onChange({ perMinute })}
          />
          <Field
            id={`${title}-hour`}
            label="Requests per hour"
            hint="Stops a patient one — a caller pacing itself just under the minute limit would otherwise run all day."
            value={scope.perHour}
            onChange={(perHour) => onChange({ perHour })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        className="max-w-40"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="text-muted-foreground min-w-0 text-xs">{hint}</p>
    </div>
  );
}
