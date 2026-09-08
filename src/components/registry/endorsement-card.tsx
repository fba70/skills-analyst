"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import {
  endorseAction,
  withdrawEndorsementAction,
} from "@/app/(protected)/curate/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { endorsementLine, MAX_ENDORSEMENT_NOTE } from "@/lib/maintainers";

/**
 * Named endorsement, beside the mechanical verdicts (Doc 6 RK.6, plan step E5).
 *
 * ## The empty state is the hard part, and it has two of them
 *
 * Over a corpus of 49,000 skills and a maintainer group appointed one category at a time, most
 * skills will have no endorsements for a long time — and the reason matters. *Nobody was
 * eligible* and *the eligible people have not* are the same empty list and opposite conclusions,
 * and a card that printed "No endorsements" for both would be the `archetypes --blocks` mistake
 * with a friendlier font: a confident zero that actually means *not measured*.
 *
 * So the card says which it is, and names the covered categories when there are any.
 *
 * ## It is never a score
 *
 * No badge in the header row, no count in the registry list, no sort. Endorsements are single
 * digits over tens of thousands of skills, so ranking on them would put four documents above
 * forty-nine thousand on the strength of who happens to have a maintainer group — the same
 * argument that keeps popularity out of R2.9's search ranking.
 */

export type EndorsementCardProps = {
  slug: string;
  endorsements: Array<{
    userId: string;
    name: string;
    note: string | null;
    at: string;
    categoryLabel: string;
    stale: boolean;
  }>;
  eligible: number;
  coveredCategories: string[];
  /** Resolved on the server from live standing, never from a role guessed in the browser. */
  viewerMayEndorse: boolean;
  viewerHasEndorsed: boolean;
};

export function EndorsementCard({
  slug,
  endorsements,
  eligible,
  coveredCategories,
  viewerMayEndorse,
  viewerHasEndorsed,
}: EndorsementCardProps) {
  /*
   * Rendered even when empty, and only for a reader who could act on it or a skill somebody
   * could endorse. A card that is always present and almost always empty trains people to skip
   * the region of the page it sits in.
   */
  if (endorsements.length === 0 && eligible === 0 && !viewerMayEndorse) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{endorsementLine(endorsements.length)}</CardTitle>
        <CardDescription>
          {endorsements.length > 0
            ? "A maintainer of one of this skill's categories has read it and vouches for it. It is the only signal here that is a person rather than a measurement."
            : eligible === 0
              ? `No maintainer group covers this skill's categories yet, so nobody is eligible to endorse it. That is a gap in our coverage, not a judgement on the skill.`
              : `${eligible} ${eligible === 1 ? "maintainer covers" : "maintainers cover"} ${coveredCategories.join(", ")}. None has endorsed this.`}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {endorsements.map((endorsement) => (
          <div key={endorsement.userId} className="grid min-w-0 gap-1 rounded-md border p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-medium">{endorsement.name}</span>
              <Badge variant="outline" className="text-[10px]">
                maintains {endorsement.categoryLabel}
              </Badge>
              {/*
                Labelled, never dropped. A re-sync can replace the document under an endorsement,
                and quietly carrying it forward would make a maintainer vouch for text they never
                read — the same call the flag queue makes about a stale report.
              */}
              {endorsement.stale ? (
                <Badge variant="outline" className="text-muted-foreground text-[10px]">
                  read an earlier version
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-xs">
                {endorsement.at.slice(0, 10)}
              </span>
            </div>
            {/* The endorser's own words, rendered as text. */}
            {endorsement.note ? (
              <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                {endorsement.note}
              </p>
            ) : null}
          </div>
        ))}

        {viewerMayEndorse ? (
          <EndorseControl slug={slug} already={viewerHasEndorsed} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function EndorseControl({ slug, already }: { slug: string; already: boolean }) {
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(endorsing: boolean) {
    startTransition(async () => {
      const outcome = endorsing
        ? await endorseAction(slug, note)
        : await withdrawEndorsementAction(slug);
      if (outcome.ok) {
        toast.success("Endorsement", { description: outcome.message });
        setNote("");
      } else {
        toast.error("Endorsement", { description: outcome.message });
      }
    });
  }

  if (already) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm">
          Your endorsement is on this skill. Withdrawing hides it everywhere at once.
        </p>
        <Button size="sm" variant="ghost" onClick={() => submit(false)} disabled={isPending}>
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={MAX_ENDORSEMENT_NOTE}
        placeholder="Why, in a sentence — optional, shown with your name"
        disabled={isPending}
        className="h-8 min-w-0 flex-1 text-sm"
      />
      <Button size="sm" variant="outline" onClick={() => submit(true)} disabled={isPending}>
        Endorse
      </Button>
    </div>
  );
}
