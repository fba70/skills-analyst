"use client";

import { useState, useTransition } from "react";
import { Crosshair, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { triggerReportAction } from "@/app/(protected)/build/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { asPercent, MIN_PROBES_PER_DIRECTION, type TriggerReport } from "@/lib/trigger";

/**
 * Does this skill fire when it should, and stay out of the way when it should not (RW.8).
 *
 * ## Why the two halves are never averaged
 *
 * Precision and recall judge the **description as written** — would a reader of that sentence
 * reach for this skill. Collision is a **retrieval** question — of everything in the corpus,
 * does this request land nearer to something else. They disagree usefully: a description can be
 * perfectly clear and still lose every request to a better-known neighbour, and only one of
 * those two facts tells the author to rewrite the sentence.
 *
 * A single "trigger score" would hide which. That is the `quality_score` mistake, where a
 * number that was never meant to discriminate ended up deciding the bands.
 *
 * ## Every empty number says why it is empty
 *
 * `null` recall is rendered as "not measured", never as 0%. A skill with no should-trigger
 * probes has unknown recall, and 0% would tell the author their skill never fires when the
 * truth is nobody has asked. Precision with nothing fired is undefined rather than perfect —
 * a skill that never triggers must not score 100% precision.
 */
export function TriggerLab({ draftId, hasProbes }: { draftId: string; hasProbes: boolean }) {
  const [report, setReport] = useState<TriggerReport | null>(null);
  const [gated, setGated] = useState(false);
  const [isPending, startTransition] = useTransition();

  function load(includeCollisions: boolean) {
    startTransition(async () => {
      const result = await triggerReportAction(draftId, includeCollisions);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setReport(result.data.report);
      setGated(result.data.collisionsGated);
      if (result.data.collisionsGated) {
        toast.info("Collision analysis is part of the full trigger lab. Showing the free half.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Crosshair className="size-4" />
          Triggering
        </CardTitle>
        <CardDescription>
          Two different questions, kept apart. Whether the description makes an agent reach for
          this skill, and whether a request lands nearer to something already in the corpus.
          Both are approximations of what a real agent does with a real library — neither is a
          measurement of it.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {report === null ? (
          <p className="text-muted-foreground text-sm">
            {hasProbes
              ? "Read the results of the trigger probes you have already run."
              : "Add a should-fire and a should-not-fire case above, run them, then check here."}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Figure
                label="Recall"
                blurb="Of the requests this should answer, how many reach it."
                value={asPercent(report.recall)}
                sample={report.counts.truePositive + report.counts.falseNegative}
              />
              <Figure
                label="Precision"
                blurb="Of the requests it would answer, how many it should."
                value={asPercent(report.precision)}
                sample={report.counts.truePositive + report.counts.falsePositive}
                /* Undefined, not perfect. A skill that never fires must not score 100%. */
                emptyReason="nothing fired, so there is nothing to be precise about"
              />
            </div>

            {report.thin ? (
              <p className="text-muted-foreground text-xs">
                Fewer than {MIN_PROBES_PER_DIRECTION} probes in one direction. These are one
                probe&rsquo;s opinion to two significant figures — worth reading, not worth
                quoting.
              </p>
            ) : null}

            {report.staleProbes > 0 || report.unrunProbes > 0 ? (
              <p className="text-muted-foreground text-xs">
                Excluded: {report.staleProbes} probe
                {report.staleProbes === 1 ? "" : "s"} judged against an older document
                {report.unrunProbes > 0 ? `, ${report.unrunProbes} never run` : ""}. Neither
                counts as a failure — run them above to bring them in.
              </p>
            ) : null}

            {report.collisions === null ? (
              <p className="text-muted-foreground border-t pt-3 text-xs">
                {gated
                  ? "Collision analysis needs the full trigger lab. It embeds every probe and compares it against the corpus."
                  : "Collisions not checked."}
              </p>
            ) : (
              <section className="grid gap-2 border-t pt-3">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Contested requests
                </h3>
                {!report.coverageReliable ? (
                  <p className="text-muted-foreground text-xs">
                    The index covers {report.coveragePercent}% of the corpus, so an empty result
                    here says more about the index than about the corpus.
                  </p>
                ) : null}
                {report.collisions.every((c) => c.nearer.length === 0) ? (
                  <p className="text-sm">
                    Every should-fire request lands nearer to this skill than to anything in the
                    corpus.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {report.collisions
                      .filter((c) => c.nearer.length > 0)
                      .map((collision) => (
                        <li key={collision.prompt} className="grid gap-1">
                          <p className="text-sm">{collision.prompt}</p>
                          <p className="text-muted-foreground text-xs tabular-nums">
                            this skill {collision.own.toFixed(3)} · nearer:{" "}
                            {collision.nearer
                              .map((hit) => `${hit.name} ${hit.similarity.toFixed(3)}`)
                              .join(", ")}
                          </p>
                        </li>
                      ))}
                  </ul>
                )}
                {/*
                  Never phrased as a defect. A request landing nearer to an established skill
                  can mean the description needs sharpening, or that the skill genuinely
                  overlaps and should be narrowed — or that the neighbour is the wrong answer
                  and this one deserves to win. No measurement here knows which.
                */}
                <p className="text-muted-foreground text-xs">
                  A contested request is worth a look, not a correction. It can mean the
                  description needs sharpening, that the scope overlaps something that already
                  exists, or that the neighbour is simply better known.
                </p>
              </section>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={isPending} onClick={() => load(false)}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Precision and recall
          </Button>
          <Button variant="outline" size="sm" disabled={isPending} onClick={() => load(true)}>
            Check for collisions
          </Button>
          <span className="text-muted-foreground text-xs">
            The first is free — it reads results you already have. The second embeds every
            probe.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  blurb,
  value,
  sample,
  emptyReason,
}: {
  label: string;
  blurb: string;
  value: string | null;
  sample: number;
  emptyReason?: string;
}) {
  return (
    <div className="grid gap-0.5 rounded-md border p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="ml-auto text-lg tabular-nums">
          {value ?? <span className="text-muted-foreground text-sm">not measured</span>}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{blurb}</p>
      <p className="text-muted-foreground text-xs tabular-nums">
        {value === null
          ? (emptyReason ?? "no probes in this direction have a current result")
          : `${sample} probe${sample === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}
