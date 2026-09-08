"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { saveModelSettingsAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MODEL_DEFAULTS,
  MODEL_TASKS,
  MODEL_TASK_META,
  type ModelSettings,
} from "@/lib/models";

/**
 * Which model each paid task calls, as an operator control.
 *
 * The third instalment of "policy becomes data", and the one that most obviously belonged
 * there from the start: a model choice is the knob that costs money, and the reason to change
 * it at short notice is that a task is spending more than it is worth. The plan recorded that
 * decision on 2026-09-06 and four constants stayed hard-coded for two days.
 *
 * ## Two things the panel says out loud
 *
 * **The rate is shown beside the id**, from the same price table billing uses. An operator
 * choosing between models is making a cost decision, and making them hold two screens in
 * their head to do arithmetic is how the wrong one gets picked.
 *
 * **An unpriced id is refused, not stored.** Billing falls back to the most expensive rate
 * known for a model it does not recognise — right for a budget, wrong as a silent
 * consequence of a typo, and the person who made the typo is the only one who could have
 * caught it immediately. The refusal names the id and the file to add a rate to.
 *
 * ## Embeddings are absent, deliberately
 *
 * The vector width is baked into the column type and into `EMBEDDER_VERSION`, so changing
 * that model is a migration and a full re-embed. A control that cannot take effect is worse
 * than no control, which is the same reason the rate-limit panel states that its paid row is
 * stored and not in force.
 */
export function ModelsPanel({
  models,
  rates,
}: {
  models: ModelSettings;
  /** Input price per million tokens, per configured id — from the billing price table. */
  rates: Record<string, number>;
}) {
  const [draft, setDraft] = useState<ModelSettings>(models);
  const [isPending, startTransition] = useTransition();

  const dirty = MODEL_TASKS.some((task) => draft[task] !== models[task]);

  function save() {
    startTransition(async () => {
      const result = await saveModelSettingsAction(draft);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>
          Which model each paid task calls, through the AI Gateway. Changing one takes effect
          on the next call with no deploy, and writes an audit row naming what moved.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {MODEL_TASKS.map((task) => {
          const rate = rates[draft[task]];
          const isDefault = draft[task] === MODEL_DEFAULTS[task];
          return (
            <div key={task} className="grid min-w-0 gap-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Label htmlFor={`model-${task}`}>{MODEL_TASK_META[task].label}</Label>
                {isDefault ? (
                  <Badge variant="ghost" className="text-muted-foreground text-[10px]">
                    default
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    changed from {MODEL_DEFAULTS[task]}
                  </Badge>
                )}
                {/*
                  The price, beside the choice. Absent means the id is not in the price
                  table, which the save will refuse — said here rather than only on submit,
                  because the useful moment to learn it is while typing.
                */}
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs tabular-nums">
                  {rate === undefined ? "not priced" : `$${rate}/MTok in`}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">{MODEL_TASK_META[task].blurb}</p>
              <Input
                id={`model-${task}`}
                value={draft[task]}
                onChange={(e) => setDraft((prev) => ({ ...prev, [task]: e.target.value }))}
                className="font-mono text-sm"
                spellCheck={false}
              />
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={!dirty || isPending}>
            {isPending ? "Saving…" : "Save models"}
          </Button>
          {dirty ? (
            <Button
              variant="ghost"
              onClick={() => setDraft(models)}
              disabled={isPending}
            >
              Reset
            </Button>
          ) : null}
          <span className="text-muted-foreground text-xs">
            A model with no entry in the price table is refused rather than saved — billing
            would charge it at the most expensive rate we know of.
          </span>
        </div>

        <p className="text-muted-foreground/80 text-xs">
          The embedding model is not listed. Its width is fixed in the column type and in the
          embedder version string, so changing it is a migration and a full re-embed rather
          than a setting.
        </p>
      </CardContent>
    </Card>
  );
}
