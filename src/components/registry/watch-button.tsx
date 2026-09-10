"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import { setWatchAction } from "@/app/(protected)/watch-actions";
import { Button } from "@/components/ui/button";

/**
 * Watch a skill (Doc 2 R8.7, plan step F5).
 *
 * Quiet, and beside the other quiet controls rather than in the header row. Following a skill is
 * something a reader decides after reading it, not the first affordance on the page — and a
 * prominent button here would compete with the download, which is what most people came for.
 *
 * Signed out it is absent rather than disabled: a control that exists only to tell somebody they
 * cannot use it is worse than the space it takes.
 */
export function WatchButton({
  skillId,
  initiallyWatching,
}: {
  skillId: string;
  initiallyWatching: boolean;
}) {
  const [watching, setWatching] = useState(initiallyWatching);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !watching;
    startTransition(async () => {
      const outcome = await setWatchAction("skill", skillId, next);
      if (!outcome.ok) {
        toast.error("Watch", { description: outcome.message });
        return;
      }
      setWatching(next);
      toast.success("Watch", {
        description: next
          ? "Watching. New versions, quarantines and licence changes appear on your dashboard."
          : "No longer watching.",
      });
    });
  }

  return (
    <Button size="sm" variant={watching ? "secondary" : "outline"} onClick={toggle} disabled={isPending}>
      {watching ? "Watching" : "Watch"}
    </Button>
  );
}
