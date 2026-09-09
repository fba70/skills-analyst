"use client";

import { useRef, useState, useTransition } from "react";

import { toast } from "sonner";

import {
  decideCandidateAction,
  distillTranscriptAction,
} from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { blockTypeLabel } from "@/lib/block-types";

/**
 * Distill mode (Doc 6 RW.5, plan step C4) — Pro.
 *
 * Point it at a working session and it proposes the rules behind the corrections in it. The
 * accept flow is C2b's, unchanged: these are the same candidate rows an interview produces and
 * the same `decideCandidateAction` decides them, which is why a distilled block lands in the
 * revision history and can become an eval case exactly as an interviewed one does.
 *
 * ## The file is read in the browser and never stored anywhere
 *
 * The transcript is read with `FileReader`, sent to a server action, parsed, and dropped. What
 * persists is a row of **counts** and the candidates themselves — each pointing at a turn uuid in
 * a file only the author holds. The panel says so, because a person about to upload a day of
 * their work should not have to infer it from a privacy policy.
 *
 * ## The counts are shown, not hidden
 *
 * *"308 turns read, 645 tool results dropped, 8 corrections found"* is the sentence that tells an
 * author what the feature actually did with their file. A bare "3 suggestions" would leave them
 * unable to tell a quiet session from a broken parser.
 */

export type DistillRunRow = {
  id: string;
  label: string | null;
  createdAt: string;
  turnsRead: number;
  humanTurns: number;
  toolResultsDropped: number;
  windowsFound: number;
  windowsSent: number;
  candidates: Array<{ id: string; type: string; text: string; decision: string }>;
};

export function DistillPanel({
  draftId,
  runs,
  entitled,
}: {
  draftId: string;
  runs: DistillRunRow[];
  entitled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [isPending, startTransition] = useTransition();

  function run() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Distill", { description: "Choose a transcript first." });
      return;
    }
    startTransition(async () => {
      const text = await file.text();
      const outcome = await distillTranscriptAction(draftId, text, label || file.name);
      if (!outcome.ok) {
        /*
         * "Read 308 turns and found no corrections" arrives here as a refusal and is rendered as
         * information, not an error — a session that went to plan holds no captured judgement,
         * and that is an answer rather than a failure.
         */
        toast.message("Distill", { description: outcome.message });
        return;
      }
      toast.success("Distill", {
        description: `${outcome.data.candidates} suggestion(s) from ${outcome.data.windowsSent} correction(s) in ${outcome.data.turnsRead} turns.`,
      });
      setLabel("");
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          Distill a working session
          <Badge variant="outline" className="text-[10px]">
            Pro
          </Badge>
        </CardTitle>
        <CardDescription>
          A Claude Code transcript (<code>~/.claude/projects/…/*.jsonl</code>). It reads the
          moments where you corrected the agent and proposes the rule behind each one. Tool output,
          model reasoning and everything that is not somebody speaking is dropped before a model
          sees any of it, and{" "}
          <strong>the transcript itself is never stored</strong> — a suggestion points at a turn in
          your own file.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {entitled ? (
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".jsonl,application/jsonl,text/plain"
              disabled={isPending}
              className="text-muted-foreground min-w-0 flex-1 text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-2 file:py-1 file:text-sm"
            />
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="What was this session? (optional)"
              disabled={isPending}
              className="h-9 min-w-0 flex-1 text-sm"
            />
            <Button onClick={run} disabled={isPending}>
              {isPending ? "Reading…" : "Distill"}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Distill is on the Pro plan. Interview mode above captures the same knowledge by asking
            for it, and is free.
          </p>
        )}

        {runs.map((run) => (
          <div key={run.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{run.label ?? "Untitled session"}</span>
              <span className="text-muted-foreground text-xs">{run.createdAt.slice(0, 10)}</span>
            </div>
            {/*
              What the run did with the file, in the run's own words.

              A bare suggestion count cannot distinguish a quiet session from a broken parser, and
              `tool results dropped` is the number that would move first if the parser ever started
              reading file contents as speech.
            */}
            <p className="text-muted-foreground text-xs">
              {run.turnsRead} turns read ({run.humanTurns} yours) · {run.toolResultsDropped} tool
              results dropped · {run.windowsFound} correction
              {run.windowsFound === 1 ? "" : "s"} found, {run.windowsSent} read
            </p>

            {run.candidates.length === 0 ? (
              <p className="text-muted-foreground/70 text-sm italic">
                No durable rule came out of this one.
              </p>
            ) : (
              run.candidates.map((candidate) => (
                <Candidate key={candidate.id} candidate={candidate} />
              ))
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Candidate({
  candidate,
}: {
  candidate: { id: string; type: string; text: string; decision: string };
}) {
  const [text, setText] = useState(candidate.text);
  const [isPending, startTransition] = useTransition();
  const decided = candidate.decision !== "pending";

  function decide(decision: "accepted" | "edited" | "rejected") {
    startTransition(async () => {
      const outcome = await decideCandidateAction(candidate.id, decision, text);
      if (outcome.ok) toast.success("Distill", { description: `Suggestion ${decision}.` });
      else toast.error("Distill", { description: outcome.message });
    });
  }

  return (
    <div className="grid gap-1.5 rounded-md border p-2.5">
      <Badge variant="outline" className="w-fit text-[10px]">
        {blockTypeLabel(candidate.type)}
      </Badge>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={decided || isPending}
        rows={3}
        className="border-input bg-background min-w-0 rounded-md border px-2 py-1.5 text-sm"
      />
      {decided ? (
        <span className="text-muted-foreground text-xs">{candidate.decision}</span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/*
            Accepted and edited stay apart, exactly as in the interview panel. Both put the block
            on the draft and they are opposite signals about the *suggestion*; collapsing them
            would flatter the one number that says whether this is working.
          */}
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => decide(text.trim() === candidate.text.trim() ? "accepted" : "edited")}
          >
            Add to draft
          </Button>
          <Button size="sm" variant="ghost" disabled={isPending} onClick={() => decide("rejected")}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
