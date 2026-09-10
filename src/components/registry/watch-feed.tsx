"use client";

import Link from "next/link";
import { useTransition } from "react";

import { toast } from "sonner";

import { markSeenAction } from "@/app/(protected)/watch-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What changed on the things you watch (Doc 2 R8.7, plan step F5).
 *
 * ## An empty feed says which empty it is
 *
 * *"You watch nothing"* and *"nothing has happened"* are the same empty list and opposite
 * conclusions, and this codebase has a section about each time that distinction was collapsed —
 * `archetypes --blocks` printing zeros at 1% coverage, the endorsement card, the loop panel's
 * unimplemented kinds. So the card says which, and the first case names where to start.
 */

export type FeedRow = {
  at: string;
  kind: string;
  label: string;
  tone: "good" | "bad" | "neutral";
  slug: string;
  name: string;
};

const TONE = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
} as const;

export function WatchFeed({ items, watches }: { items: FeedRow[]; watches: number }) {
  const [isPending, startTransition] = useTransition();

  function markSeen() {
    startTransition(async () => {
      const outcome = await markSeenAction();
      if (outcome.ok) toast.success("Watching", { description: outcome.message });
      else toast.error("Watching", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          Since you last looked
          {items.length > 0 ? <Badge variant="secondary">{items.length}</Badge> : null}
        </CardTitle>
        <CardDescription>
          {watches === 0
            ? "You are not watching anything yet. Open a skill and press Watch to be told when a new version passes validation, when one is quarantined, or when its licence is re-resolved."
            : items.length === 0
              ? `Nothing new across the ${watches} thing${watches === 1 ? "" : "s"} you watch.`
              : `Across the ${watches} thing${watches === 1 ? "" : "s"} you watch.`}
        </CardDescription>
      </CardHeader>

      {items.length > 0 ? (
        <CardContent className="grid gap-2">
          {items.slice(0, 12).map((item) => (
            <div
              key={`${item.at}:${item.slug}:${item.kind}`}
              className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm"
            >
              <span className={`${TONE[item.tone]} min-w-0`}>{item.label}</span>
              <Link
                href={`/skills/${item.slug}`}
                className="min-w-0 truncate underline underline-offset-4"
              >
                {item.name}
              </Link>
              <span className="text-muted-foreground ml-auto text-xs">{item.at.slice(0, 10)}</span>
            </div>
          ))}
          <div className="pt-1">
            <Button size="sm" variant="ghost" onClick={markSeen} disabled={isPending}>
              Mark all as seen
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
