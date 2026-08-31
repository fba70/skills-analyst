"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { saveScheduleAction, type ActionResult } from "@/app/(protected)/settings/actions";
import type { ScheduleSettings, StageDue } from "@/server/settings/schedule";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The schedule, as an operator control rather than a redeploy (Doc 3, R1.7, G2).
 *
 * ## The honest thing this page has to say
 *
 * Vercel Cron fires on a fixed expression in `vercel.ts`. Nothing here changes that, so
 * "every N hours" is a **minimum interval** the route checks when the cron does fire — it
 * can slow a stage down or switch it off, and it cannot make anything run more often than
 * the cron ticks. Implying otherwise would be the easiest lie on this screen and the one an
 * operator would find out about weeks later, wondering why their six-hour setting produced
 * twelve-hour runs.
 */
export function SchedulePanel({
  schedule,
  cronEnabled,
  cronExpression,
  status,
}: {
  schedule: ScheduleSettings;
  /** Presence of `CRON_SECRET` — the route fails closed without it, so this gates everything. */
  cronEnabled: boolean;
  cronExpression: string;
  status: { pipeline: StageDue; archetypes: StageDue };
}) {
  const [draft, setDraft] = useState<ScheduleSettings>(schedule);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(schedule);

  function save() {
    startTransition(async () => {
      const outcome = await saveScheduleAction(draft);
      setResult(outcome);
      if (outcome.ok) toast.success("Schedule", { description: outcome.message });
      else toast.error("Schedule", { description: outcome.message });
    });
  }

  return (
    <div className="grid gap-4">
      {!cronEnabled ? (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm">
            <strong>CRON_SECRET is not set</strong>, so the scheduled route refuses every
            call and nothing below runs on a timer. The route fails closed on a missing
            secret on purpose — the alternative is an open endpoint that makes us fetch
            hundreds of repositories on demand.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How this works</CardTitle>
          <CardDescription>
            The scheduler ticks on a fixed expression —{" "}
            <code className="text-xs">{cronExpression}</code> — set in{" "}
            <code className="text-xs">vercel.ts</code>. These settings decide whether a tick
            does anything. <strong>They throttle; they cannot accelerate.</strong> Asking for
            a shorter interval than the cron ticks changes nothing until the expression
            itself changes.
          </CardDescription>
        </CardHeader>
      </Card>

      <StageCard
        title="Ingestion pipeline"
        description="Sync, validate, fingerprint, dedup signatures, cluster. Free — no model calls, so this is safe to leave switched on."
        stage={draft.pipeline}
        status={status.pipeline}
        onChange={(next) => setDraft({ ...draft, pipeline: { ...draft.pipeline, ...next } })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="sources"
            label="Sources per pass"
            hint="Freshness budget, not a catch-up rate."
            value={draft.pipeline.sourcesPerPass}
            onChange={(v) =>
              setDraft({ ...draft, pipeline: { ...draft.pipeline, sourcesPerPass: v } })
            }
          />
          <Field
            id="maxskills"
            label="Max skills per source"
            hint="A larger source is held for review instead of timing the pass out."
            value={draft.pipeline.maxSkillsPerSource}
            onChange={(v) =>
              setDraft({ ...draft, pipeline: { ...draft.pipeline, maxSkillsPerSource: v } })
            }
          />
        </div>
      </StageCard>

      <StageCard
        title="Archetype refresh"
        description="Re-mines every function category from the fingerprints the pipeline has collected. Free — no model calls. G2 asks for a weekly refresh."
        stage={draft.archetypes}
        status={status.archetypes}
        onChange={(next) => setDraft({ ...draft, archetypes: { ...draft.archetypes, ...next } })}
      >
        {/*
          Said on the control itself, because "free" invites switching it on without thinking.
          Mining costs nothing to run and changes the guidance every future draft is
          scaffolded from — the risk is not the bill, it is publishing a shift nobody watched.
        */}
        <p className="text-muted-foreground text-xs">
          Costs nothing to run, but it rewrites the guidance the builder scaffolds from and
          publishes a new archetype version. Run{" "}
          <code className="text-xs">pnpm archetypes --mine-all</code> by hand first and read
          the changelog before putting it on a timer.
        </p>
      </StageCard>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={isPending || !dirty}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save schedule
        </Button>
        {dirty ? (
          <span className="text-muted-foreground text-xs">Unsaved changes.</span>
        ) : (
          <span className="text-muted-foreground text-xs">
            Every change is recorded in the audit log with who made it.
          </span>
        )}
      </div>

      {result ? (
        <p
          className={`rounded-md px-3 py-2 text-xs ${
            result.ok ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

function StageCard({
  title,
  description,
  stage,
  status,
  onChange,
  children,
}: {
  title: string;
  description: string;
  stage: { enabled: boolean; everyHours: number };
  status: StageDue;
  onChange: (next: Partial<{ enabled: boolean; everyHours: number }>) => void;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {title}
          <Badge variant={stage.enabled ? "secondary" : "outline"}>
            {stage.enabled ? "on" : "off"}
          </Badge>
          <span className="text-muted-foreground ml-auto text-xs font-normal">
            {status.reason}
            {status.lastRunAt
              ? ` · last ${status.lastRunAt.toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                })}`
              : ""}
          </span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={stage.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
              className="accent-primary size-4"
            />
            Enabled
          </label>
          <Field
            id={`${title}-hours`}
            label="Minimum hours between runs"
            value={stage.everyHours}
            onChange={(v) => onChange({ everyHours: v })}
          />
        </div>
        {children}
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
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40"
      />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
