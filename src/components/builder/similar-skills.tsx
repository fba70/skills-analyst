"use client";

import { useState, useTransition } from "react";

import { findSimilarAction } from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * What already exists that is close to what the author is about to write (R3.6).
 *
 * ## On demand, not as you type
 *
 * Every check is one metered embedding call. A fraction of a cent is nothing; a fraction of a
 * cent per keystroke is a bill nobody predicted, and this codebase already keeps every paid
 * path behind an explicit act — `taxonomy --sample`, `validate --consistency`. So it is a
 * button.
 *
 * ## The coverage caveat leads, when there is one
 *
 * During the backfill, "nothing similar exists" and "nothing comparable has been embedded
 * yet" produce the same short list and support opposite conclusions. An author who reads the
 * first when the second is true writes a duplicate. So the partial state is stated *above*
 * the results rather than as a footnote under them.
 *
 * ## It never tells the author to stop
 *
 * A high similarity is information, not a verdict. Plenty of legitimate skills are near
 * neighbours — a Django review and a Rails review should look alike — and a builder that
 * refused on a cosine score would be wrong often and unarguable when it was. The framing is
 * "here is what exists", and the decision stays the author's.
 */

type Report = {
  hits: Array<{
    slug: string;
    name: string;
    summary: string | null;
    similarity: number;
    qualityScore: number | null;
    categories: string[];
  }>;
  coveragePercent: number;
  reliable: boolean;
};

export function SimilarSkills({ text }: { text: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function look() {
    startTransition(async () => {
      const outcome = await findSimilarAction(text);
      if (outcome.ok) {
        setReport(outcome.report as Report);
        setError(null);
      } else {
        setError(outcome.message);
        setReport(null);
      }
    });
  }

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Does something like this already exist?</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={look}
          disabled={text.trim().length < 20 || isPending}
        >
          {isPending ? "Looking…" : report ? "Check again" : "Check the corpus"}
        </Button>
      </div>

      {text.trim().length < 20 ? (
        <p className="text-muted-foreground text-xs">
          Describe the purpose first — a line or two is enough to compare against.
        </p>
      ) : null}

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      {report ? (
        <>
          {!report.reliable ? (
            <p className="text-amber-600 dark:text-amber-400 text-xs">
              Only {report.coveragePercent}% of the corpus is indexed for similarity so far, so
              a short list here means &ldquo;not compared yet&rdquo; rather than &ldquo;nothing
              like it exists&rdquo;.
            </p>
          ) : null}

          {report.hits.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {report.reliable
                ? "Nothing close. That is a good sign for a new skill."
                : "No matches in what has been indexed so far."}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-xs">
                {report.hits.length} close {report.hits.length === 1 ? "match" : "matches"}.
                Similar is not the same as redundant — narrow your scope if one of these
                already does the job.
              </p>
              <ul className="grid gap-2">
                {report.hits.map((hit) => (
                  <li key={hit.slug} className="grid min-w-0 gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-2">
                      {/*
                        A new tab: the author is mid-wizard with unsaved state, and navigating
                        away from a form to compare against a neighbour would cost them the
                        thing they were comparing.
                      */}
                      <a
                        href={`/skills/${hit.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate text-sm underline underline-offset-4"
                      >
                        {hit.name}
                      </a>
                      <Badge variant="outline" className="text-[10px] tabular-nums">
                        {Math.round(hit.similarity * 100)}% alike
                      </Badge>
                      {hit.qualityScore !== null ? (
                        <span className="text-muted-foreground text-[11px]">
                          quality {hit.qualityScore}
                        </span>
                      ) : null}
                    </div>
                    {hit.categories.length > 0 ? (
                      <span className="text-muted-foreground truncate text-[11px]">
                        {hit.categories.join(" · ")}
                      </span>
                    ) : null}
                    {hit.summary ? (
                      <span className="text-muted-foreground line-clamp-2 text-xs">
                        {hit.summary}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
