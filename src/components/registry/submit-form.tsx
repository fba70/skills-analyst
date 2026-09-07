"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import { submitRepositoryAction } from "@/app/(public)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The public submission form (R1.8).
 *
 * The reply is whatever `submitRepository` actually reported, including "we already have
 * it" — which is a normal and useful answer to a suggestion rather than an error. Telling
 * somebody their repository was queued when it has been synced for months would send them
 * away believing they had contributed something.
 */
export function SubmitForm() {
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const [reply, setReply] = useState<string | null>(null);

  function submit() {
    startTransition(async () => {
      const outcome = await submitRepositoryAction(value);
      if (outcome.ok) {
        toast.success("Submitted", { description: outcome.message });
        setReply(outcome.message);
        setValue("");
      } else {
        toast.error("Not submitted", { description: outcome.message });
        setReply(null);
      }
    });
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="repo">Repository</Label>
        <Input
          id="repo"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="owner/name, or a full GitHub URL"
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() && !isPending) submit();
          }}
        />
        <span className="text-muted-foreground text-xs">
          Both forms work — `anthropics/skills` or the full https:// URL.
        </span>
      </div>

      <div>
        <Button onClick={submit} disabled={!value.trim() || isPending}>
          {isPending ? "Checking…" : "Suggest it"}
        </Button>
      </div>

      {/*
        Kept on the page as well as in the toast. A toast is gone in four seconds and the
        answer here is often something the submitter wants to read twice — "already indexed"
        and "queued for review" lead to different next actions.
      */}
      {reply ? <p className="text-sm">{reply}</p> : null}
    </div>
  );
}
