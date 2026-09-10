"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { toast } from "sonner";

import {
  addTopicAction,
  createCampaignAction,
  linkTopicAction,
  setCampaignStatusAction,
} from "@/app/(protected)/capture/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { capturedShare, TOPIC_STATE_META, type TopicState } from "@/lib/campaigns";

/**
 * A capture programme (Doc 6 RK.8, plan step E7) — Team.
 *
 * The interface is a **checklist with a date on it**, and that is the honest shape: the
 * mechanisms that capture anything are Interview and Distill, which live on the draft. What this
 * screen adds is the question neither can answer — *are we finished* — and the only way to answer
 * that is against a list somebody wrote down before the interviews started.
 *
 * So the empty state asks for the list rather than offering a button that starts work. The
 * hardest part of an expertise-capture programme is deciding what is at risk, and no software
 * does that part.
 */

export type CampaignView = {
  id: string;
  name: string;
  purpose: string | null;
  dueOn: string | null;
  status: string;
  subjectName: string | null;
  topics: Array<{
    id: string;
    title: string;
    note: string | null;
    draftId: string | null;
    draftName: string | null;
    state: TopicState;
  }>;
  progress: {
    topics: number;
    drafting: number;
    published: number;
    interviews: number;
    distillRuns: number;
    accepted: number;
  };
};

const STATE_TONE: Record<TopicState, string> = {
  "not-started": "text-muted-foreground",
  drafting: "text-amber-600 dark:text-amber-400",
  published: "text-emerald-600 dark:text-emerald-400",
};

export function CapturePanel({
  campaigns,
  drafts,
}: {
  campaigns: CampaignView[];
  drafts: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="grid gap-4">
      <NewCampaign />
      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-sm">
            No campaigns yet. One is opened before somebody rotates off, and its value is the list
            of what has to be captured — written by whoever knows what is at risk, before any
            interview starts.
          </CardContent>
        </Card>
      ) : (
        campaigns.map((campaign) => (
          <Campaign key={campaign.id} campaign={campaign} drafts={drafts} />
        ))
      )}
    </div>
  );
}

function Campaign({
  campaign,
  drafts,
}: {
  campaign: CampaignView;
  drafts: Array<{ id: string; name: string }>;
}) {
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();
  const share = capturedShare(campaign.progress);
  const closed = campaign.status === "closed";

  function add() {
    startTransition(async () => {
      const outcome = await addTopicAction(campaign.id, title, "");
      if (outcome.ok) {
        toast.success("Capture", { description: outcome.message });
        setTitle("");
      } else toast.error("Capture", { description: outcome.message });
    });
  }

  function toggleStatus() {
    startTransition(async () => {
      const outcome = await setCampaignStatusAction(campaign.id, closed ? "open" : "closed");
      if (outcome.ok) toast.success("Capture", { description: outcome.message });
      else toast.error("Capture", { description: outcome.message });
    });
  }

  return (
    <Card className={closed ? "opacity-70" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          {campaign.name}
          {closed ? <Badge variant="outline">closed</Badge> : null}
          {campaign.dueOn ? (
            <Badge variant="outline" className="text-[10px]">
              due {campaign.dueOn}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {/*
            The share, and the reason it can be absent.

            A campaign with no topics has no denominator, so it reports "not scoped yet" rather
            than 0% — those are the same zero and opposite meanings, and a bar at zero on an
            unscoped programme reads as failure.
          */}
          {share === null
            ? "Not scoped yet. Name what has to be captured and the progress becomes measurable."
            : `${campaign.progress.published} of ${campaign.progress.topics} captured (${share}%), ${campaign.progress.drafting} in progress.`}
          {campaign.purpose ? ` ${campaign.purpose}` : ""}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {campaign.topics.map((topic) => (
          <div key={topic.id} className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
            <span className={`${STATE_TONE[topic.state]} text-xs`}>
              {TOPIC_STATE_META[topic.state].label}
            </span>
            <span className="min-w-0 truncate font-medium">{topic.title}</span>
            {topic.draftId ? (
              <Link
                href={`/build/${topic.draftId}`}
                className="text-muted-foreground min-w-0 truncate text-xs underline underline-offset-4"
              >
                {topic.draftName ?? "draft"}
              </Link>
            ) : (
              <LinkDraft topicId={topic.id} drafts={drafts} />
            )}
          </div>
        ))}

        {!closed ? (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What else does only this person know?"
              disabled={isPending}
              className="h-8 min-w-0 flex-1 text-sm"
            />
            <Button size="sm" variant="outline" onClick={add} disabled={isPending || !title.trim()}>
              Add topic
            </Button>
          </div>
        ) : null}

        {/*
          Effort beside outcome, never averaged into it. "Twelve interviews" is a fact about
          work; "four of nine captured" is a fact about the result, and one number blending them
          would answer neither — the same reason lift and telemetry stay separable.
        */}
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {campaign.progress.interviews} interview session
          {campaign.progress.interviews === 1 ? "" : "s"} · {campaign.progress.distillRuns} distill
          run{campaign.progress.distillRuns === 1 ? "" : "s"} · {campaign.progress.accepted}{" "}
          suggestion{campaign.progress.accepted === 1 ? "" : "s"} kept
          <Button size="sm" variant="ghost" onClick={toggleStatus} disabled={isPending} className="ml-2 h-6">
            {closed ? "Reopen" : "Close"}
          </Button>
        </p>
      </CardContent>
    </Card>
  );
}

function LinkDraft({
  topicId,
  drafts,
}: {
  topicId: string;
  drafts: Array<{ id: string; name: string }>;
}) {
  const [isPending, startTransition] = useTransition();
  if (drafts.length === 0) return null;

  return (
    <select
      defaultValue=""
      disabled={isPending}
      onChange={(event) => {
        const draftId = event.target.value;
        if (!draftId) return;
        startTransition(async () => {
          const outcome = await linkTopicAction(topicId, draftId);
          if (outcome.ok) toast.success("Capture", { description: outcome.message });
          else toast.error("Capture", { description: outcome.message });
        });
      }}
      className="border-input bg-background h-6 rounded-md border px-1 text-xs"
    >
      <option value="">link a draft…</option>
      {drafts.map((draft) => (
        <option key={draft.id} value={draft.id}>
          {draft.name}
        </option>
      ))}
    </select>
  );
}

function NewCampaign() {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [isPending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const outcome = await createCampaignAction(name, purpose, dueOn);
      if (outcome.ok) {
        toast.success("Capture", { description: outcome.message });
        setName("");
        setPurpose("");
        setDueOn("");
      } else toast.error("Capture", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Open a capture programme</CardTitle>
        <CardDescription>
          Before somebody rotates off, name what only they know. Interview and Distill run against
          the list from each topic&rsquo;s draft; this screen is what says whether you are
          finished.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Whose knowledge, and why now"
          disabled={isPending}
          className="h-9 min-w-0 flex-1 text-sm"
        />
        <Input
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          placeholder="Context, optional"
          disabled={isPending}
          className="h-9 min-w-0 flex-1 text-sm"
        />
        <input
          type="date"
          value={dueOn}
          onChange={(event) => setDueOn(event.target.value)}
          disabled={isPending}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        />
        <Button onClick={create} disabled={isPending || !name.trim()}>
          Open
        </Button>
      </CardContent>
    </Card>
  );
}
