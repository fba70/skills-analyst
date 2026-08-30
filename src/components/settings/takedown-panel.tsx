"use client";

import { useState, useTransition } from "react";
import { Loader2, ScrollText, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import {
  recordTakedownAction,
  reinstateTakedownAction,
  rejectTakedownAction,
  upholdTakedownAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The takedown queue (Doc 2 R7.5).
 *
 * Two halves, in the order the work happens: record what arrived, then decide it. They are
 * deliberately not one step. Logging a notice is free and reversible; upholding one deletes
 * bytes from R2 and un-lists content, and a form whose submit button did both would make
 * the destructive path the default.
 *
 * Every decision here asks for a note, and a rejection requires one. "Why was this refused"
 * is the question a second notice about the same skill will ask, and the answer has to be
 * on the record rather than in somebody's memory.
 */

const GROUNDS = [
  { value: "copyright", label: "Copyright (DMCA)" },
  { value: "license_violation", label: "Licence violation" },
  { value: "privacy", label: "Privacy" },
  { value: "trademark", label: "Trademark" },
  { value: "author_request", label: "Author request" },
  { value: "other", label: "Other" },
] as const;

export type TakedownListRow = {
  id: string;
  scope: string;
  status: string;
  grounds: string;
  sourceUrl: string;
  skillPath: string | null;
  requester: string;
  claim: string;
  receivedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  contentDeleted: boolean;
  affectedSkills: number;
  skillSlug: string | null;
  skillName: string | null;
};

export function TakedownPanel({ takedowns }: { takedowns: TakedownListRow[] }) {
  return (
    <div className="grid gap-4">
      <RecordCard />
      {takedowns.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            No takedown requests on record.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {takedowns.map((row) => (
            <li key={row.id}>
              <TakedownCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecordCard() {
  const [scope, setScope] = useState<"skill" | "source">("skill");
  const [target, setTarget] = useState("");
  const [requester, setRequester] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [grounds, setGrounds] = useState<(typeof GROUNDS)[number]["value"]>("copyright");
  const [claim, setClaim] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const outcome = await recordTakedownAction({
        scope,
        target,
        requester,
        requesterEmail,
        grounds,
        claim,
      });
      setResult(outcome);
      if (outcome.ok) {
        toast.success("Takedown", { description: outcome.message });
        setTarget("");
        setRequester("");
        setRequesterEmail("");
        setClaim("");
      } else {
        toast.error("Takedown", { description: outcome.message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="text-muted-foreground size-4" />
          Record a request
        </CardTitle>
        <CardDescription>
          Notices arrive by email; this is where one becomes a record. Logging it withdraws
          nothing — that is a second, deliberate decision below. A claim that is later
          refused stays on file, which is the half of this that protects the platform.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="td-scope">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "skill" | "source")}>
              <SelectTrigger id="td-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skill">One skill</SelectItem>
                <SelectItem value="source">A whole repository</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="td-target">
              {scope === "skill" ? "Skill slug" : "Repository"}
            </Label>
            <Input
              id="td-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={scope === "skill" ? "django-perf-review" : "owner/name"}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="td-requester">Requested by</Label>
            <Input
              id="td-requester"
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
              placeholder="Name or organisation"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="td-email">Contact (optional)</Label>
            <Input
              id="td-email"
              value={requesterEmail}
              onChange={(e) => setRequesterEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="td-grounds">Grounds</Label>
            <Select
              value={grounds}
              onValueChange={(v) => setGrounds(v as (typeof GROUNDS)[number]["value"])}
            >
              <SelectTrigger id="td-grounds">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUNDS.map((g) => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="td-claim">What was claimed</Label>
          <textarea
            id="td-claim"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            rows={3}
            placeholder="In the requester's words — this is the evidence the decision is made against."
            className="border-input bg-transparent placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-16 w-full rounded-md border px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={submit} disabled={isPending} size="sm">
            {isPending ? <Loader2 className="size-4 animate-spin" /> : <ScrollText className="size-4" />}
            Log the request
          </Button>
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
      </CardContent>
    </Card>
  );
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  received: "default",
  upheld: "destructive",
  rejected: "outline",
  reinstated: "secondary",
};

function TakedownCard({ row }: { row: TakedownListRow }) {
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<ActionResult>) {
    startTransition(async () => {
      const outcome = await action();
      if (outcome.ok) {
        toast.success("Takedown", { description: outcome.message });
        setNote("");
      } else {
        toast.error("Takedown", { description: outcome.message });
      }
    });
  }

  const target =
    row.scope === "source"
      ? row.sourceUrl.replace(/^https?:\/\/github\.com\//, "")
      : (row.skillName ?? row.skillPath ?? row.sourceUrl);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="truncate">{target}</span>
          <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
          <Badge variant="outline">{row.scope}</Badge>
          <Badge variant="outline">{row.grounds.replace(/_/g, " ")}</Badge>
        </CardTitle>
        <CardDescription>
          {row.requester} ·{" "}
          {row.receivedAt.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
          {row.status === "upheld" ? (
            <>
              {" "}
              · {row.affectedSkills} skill(s) withdrawn ·{" "}
              {row.contentDeleted ? "content deleted" : "content still in storage"}
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-muted-foreground border-l-2 pl-3 text-sm">{row.claim}</p>

        {row.skillPath ? (
          <p className="text-muted-foreground font-mono text-xs">
            {row.sourceUrl.replace(/^https?:\/\/github\.com\//, "")} · {row.skillPath}
          </p>
        ) : null}

        {row.decisionNote ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Decision: </span>
            {row.decisionNote}
          </p>
        ) : null}

        {row.status === "received" || row.status === "upheld" ? (
          <div className="grid gap-2 border-t pt-3">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                row.status === "upheld"
                  ? "Why is this being reinstated? (required)"
                  : "Decision note"
              }
            />
            <div className="flex flex-wrap gap-2">
              {row.status === "received" ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={isPending}
                    onClick={() => run(() => upholdTakedownAction(row.id, note))}
                  >
                    {isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ShieldOff className="size-4" />
                    )}
                    Uphold — withdraw and block
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => run(() => rejectTakedownAction(row.id, note))}
                  >
                    Reject
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => run(() => reinstateTakedownAction(row.id, note))}
                >
                  Reinstate
                </Button>
              )}
            </div>
            {row.status === "upheld" ? (
              <p className="text-muted-foreground text-xs">
                Reinstating lifts the block and restores the metadata. The content itself
                returns on the next sync — the mirrored copy was deleted.
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Upholding deletes the mirrored bytes, un-lists the content, and blocks the
                path from being fetched again. A rejection needs a reason.
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
