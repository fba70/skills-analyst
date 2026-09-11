"use client";

import { useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";

import { blockFragmentsAction } from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import type { ScaffoldBlock } from "@/server/builder/scaffold";

/**
 * The block library in the builder — Compose mode's first real surface (Doc 6 RW.3).
 *
 * The archetype tells an author *a curated review skill carries a decision rule, 75%
 * against 55%*. Their next question is immediate, and until now the platform had no answer:
 * **what does a good one look like?** The exemplar list is eight whole skills, which asks
 * somebody to open eight documents and find the relevant passage in each.
 *
 * ## Fetched per type, on the author's click
 *
 * Each fragment is a read from object storage. Loading five block types with the step would
 * be five bundle fan-outs before the author has asked to see any of them — the same posture
 * as the similarity check next door, and as every paid path in this codebase.
 *
 * ## Attribution is not optional decoration
 *
 * Most of this corpus is `attribution_required`, and a panel that shows a stranger's
 * paragraph without naming them is the platform breaking the licence it enforces on
 * downloads. So every fragment renders its repository and links to the skill, and a fragment
 * whose licence forbids copying renders **attribution and a link instead of the text** —
 * which is a real answer, not a failure.
 *
 * ## It never offers to insert one
 *
 * There is no copy button and no "use this". A library that pastes a stranger's paragraph
 * into an author's draft manufactures exactly the homogenisation Doc 2's risk register warns
 * about, and it would launder an attribution-required fragment into a document with no
 * attribution. These are examples to read.
 */

type Fragment = {
  id: string;
  wordCount: number;
  tokenEstimate: number;
  text: string | null;
  withheld: "licence" | "unavailable" | null;
  attribution: {
    slug: string;
    name: string;
    source: string;
    sourceUrl: string | null;
    qualityScore: number | null;
    curated: boolean;
  };
};

type Result = {
  fragments: Fragment[];
  candidates: number;
  withheldForLicence: number;
  bandEmpty: boolean;
};

export function BlockLibrary({
  category,
  blocks,
}: {
  category: string;
  blocks: ScaffoldBlock[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function toggle(type: string) {
    if (open === type) {
      setOpen(null);
      return;
    }
    setOpen(type);
    // Cached per type for the life of the step: the corpus does not change mid-wizard, and
    // re-reading four bundles because somebody collapsed a panel is pure waste.
    if (results[type] || errors[type]) return;
    startTransition(async () => {
      const outcome = await blockFragmentsAction(category, type);
      if (outcome.ok) {
        setResults((prev) => ({ ...prev, [type]: outcome.data as Result }));
      } else {
        setErrors((prev) => ({ ...prev, [type]: outcome.message }));
      }
    });
  }

  if (blocks.length === 0) return null;

  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground text-xs">
        Open one to read real passages from skills in this category. Examples to learn from,
        not text to copy — each is somebody else&rsquo;s work and stays theirs.
      </p>

      <ul className="grid gap-1.5">
        {blocks.map((block) => {
          const result = results[block.type];
          const isOpen = open === block.type;
          return (
            <li key={block.type} className="rounded-md border">
              <button
                type="button"
                onClick={() => toggle(block.type)}
                aria-expanded={isOpen}
                className="hover:bg-muted/50 flex w-full flex-wrap items-center gap-2 rounded-md px-3 py-2 text-left"
              >
                <ChevronDown
                  className={`size-3.5 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                  aria-hidden
                />
                <span className="min-w-0 text-sm font-medium">{block.label}</span>
                {block.required ? (
                  <Badge variant="secondary" className="text-[11px]">
                    expected
                  </Badge>
                ) : null}
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs tabular-nums">
                  {block.strongPrevalence}% / {block.weakPrevalence}%
                </span>
              </button>

              {isOpen ? (
                <div className="grid gap-3 border-t px-3 py-3">
                  {isPending && !result ? (
                    <p className="text-muted-foreground text-xs">Reading the corpus…</p>
                  ) : null}
                  {errors[block.type] ? (
                    <p className="text-destructive text-xs">{errors[block.type]}</p>
                  ) : null}
                  {result ? <Fragments result={result} /> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The fragment list itself, exported because `/tools/<id>` shows the same thing (Doc 7 RD.9).
 *
 * One renderer, not two. Attribution and the withheld-for-licence notice are the licence
 * obligation rendered wherever the content appears — a second copy on the tool page is a
 * second place for one of them to be dropped, and the axis where that matters is the legal
 * one. It takes plain props and holds no state, so a server page can render it directly.
 */
export function Fragments({ result }: { result: Result }) {
  if (result.fragments.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No example of this block type is available in this category yet. The archetype still
        measured it — this is a gap in what can be quoted, not evidence against writing one.
      </p>
    );
  }

  return (
    <>
      <ul className="grid gap-3">
        {result.fragments.map((fragment) => (
          <li key={fragment.id} className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              {/*
                A new tab: the author is mid-wizard with unsaved state, and navigating away
                from the form to read a neighbour would cost them the thing they were writing.
              */}
              <a
                href={`/skills/${fragment.attribution.slug}`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-medium underline underline-offset-4"
              >
                {fragment.attribution.name}
              </a>
              {/* The licence obligation, rendered wherever the content appears. */}
              <span className="text-muted-foreground min-w-0 truncate">
                {fragment.attribution.source}
              </span>
              {fragment.attribution.curated ? (
                <Badge variant="outline" className="text-[10px]">
                  curated source
                </Badge>
              ) : (
                <Badge variant="ghost" className="text-muted-foreground text-[10px]">
                  wider corpus
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">
                {fragment.wordCount} words · ~{fragment.tokenEstimate} tokens
              </span>
            </div>

            {fragment.text ? (
              /*
               * `whitespace-pre-wrap`, not rendered markdown.
               *
               * This is untrusted text from a stranger's document (R7.3). Rendering it as
               * markup would let a corpus skill inject a link or an image into our own
               * interface, and the author is here to read what the passage says rather than
               * to see it typeset. Same posture the analyzers' finding messages take.
               */
              <pre className="bg-muted/40 min-w-0 overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">
                {fragment.text}
              </pre>
            ) : (
              <p className="text-muted-foreground border-l-2 pl-2 text-xs">
                {fragment.withheld === "licence" ? (
                  <>
                    This skill&rsquo;s licence does not permit copying its content, so the
                    passage is not shown here.{" "}
                    {fragment.attribution.sourceUrl ? (
                      <a
                        href={fragment.attribution.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-4"
                      >
                        Read it at the origin
                      </a>
                    ) : null}
                  </>
                ) : (
                  <>No mirrored copy of this passage is available right now.</>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>

      {result.withheldForLicence > 0 ? (
        <p className="text-muted-foreground text-[11px]">
          {result.withheldForLicence} of {result.candidates} shown without their text —
          licence does not permit copying.
        </p>
      ) : null}
    </>
  );
}
