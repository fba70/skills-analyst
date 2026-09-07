"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import { decideFlagAction, type ActionResult } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FLAG_REASON_META, triageOf, type FlagReason } from "@/lib/flags";

/**
 * The curator side of community flagging (R2.5).
 *
 * ## Security first, and the ordering is not a preference
 *
 * The queue arrives already sorted by triage — the three security reasons, then quality,
 * then metadata — because a report that a skill contains a credential is a different kind of
 * thing from a report that its description is vague, and a queue sorted purely by age buries
 * the first behind the second.
 *
 * ## Upholding does not quarantine
 *
 * It marks the flag, records the R6.3 outcome signal, and queues the version for
 * **re-validation**. The analyzers decide what happens next. A curator forcing a
 * `quarantined` status directly would produce a withheld skill with no verdict row explaining
 * why, which is exactly the gap R7.1 exists to close — the reader of that skill's page would
 * see "quarantined" and no reason.
 *
 * ## A decision needs its reasoning
 *
 * Both buttons are disabled until something is typed. A queue of decisions with no reasons is
 * unauditable six months later, and this is the surface where that record is cheapest to
 * capture and most expensive to reconstruct.
 */

export type FlagRow = {
  id: string;
  slug: string;
  name: string;
  skillStatus: string;
  reason: FlagReason;
  note: string | null;
  contact: string | null;
  createdAt: string;
  stale: boolean;
};

const TRIAGE_TONE = {
  security: "border-red-500/40 text-red-600 dark:text-red-400",
  quality: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  metadata: "text-muted-foreground",
} as const;

export function FlagsPanel({ rows }: { rows: FlagRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Community flags (R2.5)</CardTitle>
        <CardDescription>
          Reader reports, security first. Upholding queues the version for re-validation and
          records an outcome signal — it does not quarantine anything directly, because that
          decision belongs to the analyzers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing waiting. Reports arrive from the &ldquo;Report a problem&rdquo; form on
            each skill page.
          </p>
        ) : (
          rows.map((row) => <FlagCard key={row.id} row={row} />)
        )}
      </CardContent>
    </Card>
  );
}

function FlagCard({ row }: { row: FlagRow }) {
  const [decision, setDecision] = useState("");
  const [isPending, startTransition] = useTransition();
  const triage = triageOf(row.reason);

  function decide(uphold: boolean) {
    startTransition(async () => {
      const outcome: ActionResult = await decideFlagAction(row.id, uphold, decision);
      if (outcome.ok) toast.success("Flag", { description: outcome.message });
      else toast.error("Flag", { description: outcome.message });
    });
  }

  return (
    <div className="grid min-w-0 gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="outline" className={TRIAGE_TONE[triage]}>
          {triage}
        </Badge>
        <span className="text-sm font-medium">{FLAG_REASON_META[row.reason].label}</span>
        {/*
          Surfaced rather than hidden: "this is broken" is a statement about content, and a
          re-sync may have replaced it before anyone read the report. A curator who cannot
          tell a stale report from a live one will eventually re-quarantine a fixed skill.
        */}
        {row.stale ? (
          <Badge variant="outline" className="text-muted-foreground text-[10px]">
            a newer version has replaced the one reported
          </Badge>
        ) : null}
        {row.skillStatus !== "indexed" ? (
          <Badge variant="outline" className="text-[10px]">
            skill is {row.skillStatus}
          </Badge>
        ) : null}
      </div>

      <a
        href={`/skills/${row.slug}`}
        className="min-w-0 truncate text-sm underline underline-offset-4"
      >
        {row.name}
      </a>

      {/*
        The reporter's own words, rendered as **text**. Never as markup and never handed to a
        model without the R7.3 fence: this is free text from a stranger about content that may
        itself be adversarial.
      */}
      {row.note ? (
        <p className="text-muted-foreground bg-muted/40 rounded px-2 py-1.5 text-sm whitespace-pre-wrap">
          {row.note}
        </p>
      ) : (
        <p className="text-muted-foreground/70 text-sm italic">No note given.</p>
      )}

      <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
        <span>{row.createdAt.slice(0, 10)}</span>
        {row.contact ? <span>contact: {row.contact}</span> : <span>no contact given</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={decision}
          onChange={(event) => setDecision(event.target.value)}
          placeholder="Why — recorded on the row"
          disabled={isPending}
          className="h-8 min-w-0 flex-1 text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => decide(true)}
          disabled={!decision.trim() || isPending}
        >
          Uphold
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => decide(false)}
          disabled={!decision.trim() || isPending}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
