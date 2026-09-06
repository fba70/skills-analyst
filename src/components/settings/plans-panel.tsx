"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import { setPlanAction, type ActionResult } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FEATURE_META,
  FREE_FOREVER,
  PLAN_FEATURES,
  PLAN_META,
  PLANS,
  type Plan,
} from "@/lib/plans";

/**
 * Plans, per workspace (Doc 2 RC.1).
 *
 * ## The panel says what is not in effect, out loud
 *
 * Every feature a plan unlocks except one does not exist yet — Distill, the Eval Lab, MCP
 * authoring are all later plan steps. A panel that offered "Pro" as though it switched
 * something on would be a control that silently does nothing, which the rate-limit panel
 * already refuses to be for the same reason. So each feature carries whether it is live, and
 * the header says how many are.
 *
 * ## And it states the exemption
 *
 * The free-tier trust surfaces are listed here, on the screen where somebody would go
 * looking for a way to sell them. They are not options with a switch turned off — they
 * cannot be gated at all, and the gate throws if asked. Saying so in the admin UI is cheaper
 * than the conversation that follows someone trying.
 */

export type PlanRow = {
  organizationId: string;
  name: string;
  slug: string | null;
  plan: Plan;
  note: string | null;
  validUntil: string | null;
  members: number;
};

/** The one feature with a live call site. Everything else is schema waiting for a build. */
const LIVE_FEATURES = new Set(["mcp-elevated-limits"]);

export function PlansPanel({ rows }: { rows: PlanRow[] }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace plans</CardTitle>
          <CardDescription>
            Entitlements are checked in the data-access layer, so a plan change takes effect
            on the next request through any surface — web, server action or MCP.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-(--card-spacing)">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="hidden sm:table-cell">Note</TableHead>
                <TableHead className="hidden sm:table-cell">Expires</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <PlanRowEditor key={row.organizationId} row={row} />
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No workspaces yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What each plan unlocks</CardTitle>
          <CardDescription>
            {LIVE_FEATURES.size} of{" "}
            {new Set(Object.values(PLAN_FEATURES).flat()).size} features have a live call
            site. The rest are the entitlement keys their plan steps are built against.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {PLANS.map((plan) => (
            <div key={plan} className="grid gap-1.5">
              <div className="flex items-baseline gap-2">
                <strong className="text-sm">{PLAN_META[plan].label}</strong>
                <span className="text-muted-foreground text-xs">{PLAN_META[plan].blurb}</span>
              </div>
              {PLAN_FEATURES[plan].length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Everything below, and nothing is gated.
                </p>
              ) : (
                <ul className="grid gap-1">
                  {PLAN_FEATURES[plan].map((feature) => (
                    <li key={feature} className="flex items-baseline gap-2 text-sm">
                      <span>{FEATURE_META[feature].label}</span>
                      {LIVE_FEATURES.has(feature) ? (
                        <Badge variant="secondary" className="text-[10px]">
                          live
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/70 text-[11px]">
                          not built yet
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Free on every plan, permanently</CardTitle>
          <CardDescription>
            These are not switched off for paid plans — they cannot be gated. The entitlement
            gate throws if any code asks whether a workspace is entitled to one, so the
            paywall cannot be added by configuration or by accident.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {FREE_FOREVER.map((key) => (
              <Badge key={key} variant="outline" className="font-normal">
                {key.replace(/-/g, " ")}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PlanRowEditor({ row }: { row: PlanRow }) {
  const [plan, setPlan] = useState<Plan>(row.plan);
  const [note, setNote] = useState(row.note ?? "");
  const [isPending, startTransition] = useTransition();

  const dirty = plan !== row.plan || note !== (row.note ?? "");

  function save() {
    startTransition(async () => {
      const outcome: ActionResult = await setPlanAction(row.organizationId, plan, note);
      if (outcome.ok) toast.success("Plan", { description: outcome.message });
      else toast.error("Plan", { description: outcome.message });
    });
  }

  return (
    <TableRow>
      <TableCell className="min-w-0">
        <span className="block truncate font-medium">{row.name}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {row.members} member{row.members === 1 ? "" : "s"}
        </span>
      </TableCell>
      <TableCell>
        {/*
          A plain select, not a fancy one. Three values that change how much a customer is
          charged deserve the control with the fewest ways to misfire.
        */}
        <select
          value={plan}
          onChange={(event) => setPlan(event.target.value as Plan)}
          disabled={isPending}
          aria-label={`Plan for ${row.name}`}
          className="border-input bg-background rounded-md border px-2 py-1 text-sm"
        >
          {PLANS.map((option) => (
            <option key={option} value={option}>
              {PLAN_META[option].label}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="hidden min-w-0 sm:table-cell">
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={isPending}
          placeholder="trial, design partner, …"
          aria-label={`Note for ${row.name}`}
          className="h-8 text-sm"
        />
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
        {row.validUntil ? row.validUntil.slice(0, 10) : "—"}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={save} disabled={!dirty || isPending}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
