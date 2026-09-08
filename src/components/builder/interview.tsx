"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useTransition } from "react";
import { Check, Loader2, MessageSquare, Pencil, Send, Square, X } from "lucide-react";
import { toast } from "sonner";

import {
  decideCandidateAction,
  endInterviewAction,
  startInterviewAction,
} from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { blockTypeLabel } from "@/lib/block-types";
import { formatConversationSpend, type ConversationBudget } from "@/lib/conversation";
import {
  INTERVIEW_TECHNIQUE_META,
  INTERVIEW_TECHNIQUES,
  type InterviewTechnique,
} from "@/lib/interview";

/**
 * Interview mode (Doc 6 RW.4, plan step C2b).
 *
 * ## What the author sees, and why it is shaped like this
 *
 * A question, a box, and — after each answer — a short list of typed blocks with accept and
 * reject beside them. The accept/reject **is** R5.4's per-suggestion feedback: there is no
 * thumbs-up control anywhere, because a rating asked for its own sake is the control everybody
 * ignores. Here the feedback is the action the author already wanted to take.
 *
 * ## The budget is on screen from the first turn
 *
 * A conversation can be refused mid-way, and that is unavoidable — the alternative is
 * reserving money up front, which fails by taking budget from people who abandoned a tab. What
 * makes the refusal acceptable is that it is never a surprise: the gauge is beside the input
 * from turn one, so it reads as a fuel gauge rather than a wall.
 *
 * ## Techniques are chosen, not blended
 *
 * Five buttons rather than one "interview me". They ask genuinely different questions, and an
 * author knows which of "walk me through the last time" and "when is the normal answer wrong"
 * fits what they are trying to get out. Choosing also makes the loop measurable — every
 * candidate carries its session's technique, so which ones actually produce kept blocks is a
 * query rather than an opinion.
 */

type Candidate = { id: string; type: string; text: string; decision: string };

type Turn =
  | { role: "assistant"; text: string; candidates: Candidate[] }
  | { role: "author"; text: string };

export function Interview({
  draftId,
  sessionId: initialSessionId,
  initialTurns,
  budget,
}: {
  draftId: string;
  sessionId: string | null;
  initialTurns: Turn[];
  budget: ConversationBudget | null;
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [running, setRunning] = useState(false);
  const [spent, setSpent] = useState(budget?.spentMicros ?? 0);
  const [remaining, setRemaining] = useState(budget?.remainingMicros ?? null);
  const [ended, setEnded] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const abort = useRef<AbortController | null>(null);

  const send = useCallback(
    async (id: string, text: string) => {
      setRunning(true);
      setDraftQuestion("");
      if (text.trim()) setTurns((current) => [...current, { role: "author", text: text.trim() }]);

      const controller = new AbortController();
      abort.current = controller;

      try {
        const response = await fetch(`/api/interview/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });

        if (response.status === 402) {
          const payload = (await response.json()) as { error: string; block: string };
          setEnded(payload.error);
          toast.warning(payload.error);
          router.refresh();
          return;
        }
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          toast.error(payload.error ?? "The interview could not continue.");
          return;
        }

        /*
         * NDJSON, read line by line. A chunk can split a line, so the remainder is carried —
         * the bug every hand-written stream reader has once, and it shows up as a JSON parse
         * error on a long question rather than on a short one.
         */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as
              | { type: "partial"; value: { question?: string } }
              | { type: "done"; question: string; candidates: Candidate[]; metered: { costMicros: number } }
              | { type: "error"; message: string };

            if (event.type === "partial") {
              if (typeof event.value?.question === "string") setDraftQuestion(event.value.question);
            } else if (event.type === "done") {
              setDraftQuestion("");
              setTurns((current) => [
                ...current,
                {
                  role: "assistant",
                  text: event.question,
                  candidates: event.candidates.map((c) => ({ ...c, decision: "pending" })),
                },
              ]);
              setSpent((value) => value + event.metered.costMicros);
              setRemaining((value) =>
                value === null ? null : Math.max(0, value - event.metered.costMicros),
              );
            } else {
              toast.error(event.message);
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          toast.error((error as Error).message);
        }
      } finally {
        setRunning(false);
        abort.current = null;
      }
    },
    [router],
  );

  function begin(technique: InterviewTechnique) {
    startTransition(async () => {
      const result = await startInterviewAction(draftId, technique);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setSessionId(result.data.sessionId);
      setTurns([]);
      setEnded(null);
      await send(result.data.sessionId, "");
    });
  }

  function decide(candidateId: string, decision: "accepted" | "edited" | "rejected", text?: string) {
    startTransition(async () => {
      const result = await decideCandidateAction(candidateId, decision, text);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setTurns((current) =>
        current.map((turn) =>
          turn.role === "assistant"
            ? {
                ...turn,
                candidates: turn.candidates.map((c) =>
                  c.id === candidateId ? { ...c, decision, text: text ?? c.text } : c,
                ),
              }
            : turn,
        ),
      );
      /*
       * The draft is a server component above this one, so an accepted block only appears in
       * the editor after a refresh. Refreshing on every decision rather than on leaving is the
       * right trade: seeing the block land is the confirmation that accepting did something.
       */
      if (decision !== "rejected") router.refresh();
    });
  }

  if (!sessionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="size-4" />
            Interview
          </CardTitle>
          <CardDescription>
            A form captures what you can already put into words. These questions are for the
            rest — the exception you always make, the thing you check first. Every answer comes
            back as blocks you accept or throw away.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {INTERVIEW_TECHNIQUES.map((technique) => (
            <button
              key={technique}
              type="button"
              disabled={isPending}
              onClick={() => begin(technique)}
              className="hover:bg-accent grid gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-50"
            >
              <span className="text-sm font-medium">
                {INTERVIEW_TECHNIQUE_META[technique].label}
              </span>
              <span className="text-muted-foreground text-xs">
                {INTERVIEW_TECHNIQUE_META[technique].blurb}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <MessageSquare className="size-4" />
          Interview
          <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">
            {formatConversationSpend(spent)} spent
            {remaining !== null ? ` · ${formatConversationSpend(remaining)} left` : ""}
          </span>
        </CardTitle>
        <CardDescription>
          Accepting a block adds it to the draft above. Rejecting one is a real answer and is
          recorded — it is how the platform learns which questions are worth asking.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {turns.map((turn, index) => (
          <div key={index} className="grid gap-2">
            <div
              className={
                turn.role === "author"
                  ? "bg-muted ml-8 rounded-md p-3 text-sm whitespace-pre-wrap"
                  : "text-sm whitespace-pre-wrap"
              }
            >
              {turn.text}
            </div>
            {turn.role === "assistant" && turn.candidates.length > 0 ? (
              <ul className="grid gap-2">
                {turn.candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    busy={isPending}
                    onDecide={decide}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ))}

        {draftQuestion ? (
          <p className="text-sm whitespace-pre-wrap">
            {draftQuestion}
            <span className="bg-foreground ml-0.5 inline-block h-4 w-1.5 animate-pulse align-text-bottom" />
          </p>
        ) : null}

        {ended ? (
          <p className="text-muted-foreground border-t pt-3 text-sm">{ended}</p>
        ) : (
          <div className="grid gap-2 border-t pt-3">
            <textarea
              className="border-input bg-background focus-visible:ring-ring/50 min-h-20 w-full resize-y rounded-md border p-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none"
              placeholder="Answer in your own words. Detail is the point — nothing here is graded."
              value={answer}
              disabled={running}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  const text = answer;
                  setAnswer("");
                  void send(sessionId, text);
                }}
                disabled={running || !answer.trim()}
              >
                {running ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Answer
              </Button>
              {running ? (
                <Button variant="ghost" onClick={() => abort.current?.abort()}>
                  <Square className="size-4" />
                  Stop
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      await endInterviewAction(sessionId);
                      setEnded("Interview closed. Your accepted blocks are on the draft.");
                      router.refresh();
                    })
                  }
                >
                  Finish
                </Button>
              )}
              {/*
                Stopping abandons the reader, not the turn. The server drains and meters it
                either way — that is the whole point of the seam — so the honest label is
                "stop showing me this", and pretending it saves money would be a lie the
                ledger would contradict.
              */}
              <span className="text-muted-foreground text-xs">
                Stopping hides the rest of the answer; the turn is already paid for.
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CandidateRow({
  candidate,
  busy,
  onDecide,
}: {
  candidate: Candidate;
  busy: boolean;
  onDecide: (id: string, decision: "accepted" | "edited" | "rejected", text?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(candidate.text);
  const decided = candidate.decision !== "pending";

  return (
    <li className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{blockTypeLabel(candidate.type)}</Badge>
        {decided ? (
          <Badge variant={candidate.decision === "rejected" ? "outline" : "secondary"}>
            {candidate.decision}
          </Badge>
        ) : null}
      </div>

      {editing ? (
        <textarea
          className="border-input bg-background min-h-20 w-full resize-y rounded-md border p-2 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className="text-sm whitespace-pre-wrap">{candidate.text}</p>
      )}

      {decided ? null : (
        <div className="flex flex-wrap gap-1">
          {editing ? (
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onDecide(candidate.id, "edited", text)}>
              <Check className="size-3.5" />
              Add my version
            </Button>
          ) : (
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => onDecide(candidate.id, "accepted")}>
              <Check className="size-3.5" />
              Add to draft
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => setEditing((value) => !value)}
          >
            <Pencil className="size-3.5" />
            {editing ? "Cancel edit" : "Fix it first"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground h-7 text-xs"
            disabled={busy}
            onClick={() => onDecide(candidate.id, "rejected")}
          >
            <X className="size-3.5" />
            No
          </Button>
        </div>
      )}
    </li>
  );
}
