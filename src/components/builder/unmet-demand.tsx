"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { unmetDemandAction } from "@/app/(protected)/build/actions";
import { MIN_DISTINCT_SEARCHERS, type DemandRow } from "@/lib/demand";

/**
 * "People are asking for this and not finding it" (Doc 2 R5.3, Doc 6 RK.5).
 *
 * ## The counterweight to the similarity panel beside it
 *
 * `SimilarSkills` shows an author what already exists, which is an argument for narrowing or
 * stopping. This shows what people keep searching for and not finding, which is an argument for
 * carrying on. Showing only the first would make the builder a discouragement machine — every
 * idea looks redundant next to 49,000 skills, and the one measurement that says otherwise is this.
 *
 * ## Rendered quietly, and absent when there is nothing
 *
 * A trigram match over recorded queries, so it costs nothing and needs no button — unlike the
 * similarity check, which is a metered embedding and is therefore a control. When nothing matches
 * the component renders nothing at all rather than an empty state: "no unmet demand found" reads
 * as a verdict on the idea, and it is not one. The corpus only knows what people searched for.
 */
export function UnmetDemand({ text }: { text: string }) {
  const [rows, setRows] = useState<DemandRow[]>([]);

  useEffect(() => {
    /*
     * Debounced, and cancelled on the way out. Free per call, but a query per keystroke is a
     * query per keystroke, and the component unmounts when the author moves to the next step.
     *
     * The too-short case clears **inside** the timer rather than synchronously in the effect
     * body. Not a lint appeasement: a synchronous set on every render of a controlled input is a
     * second render per keystroke, and doing it in the timer also stops the list flashing empty
     * between two words of a purpose somebody is still typing.
     */
    let live = true;
    const timer = setTimeout(async () => {
      if (text.trim().length < 8) {
        if (live) setRows([]);
        return;
      }
      const result = await unmetDemandAction(text);
      if (live && result.ok) setRows(result.data.rows);
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  if (rows.length === 0) return null;

  return (
    <div className="grid gap-1 rounded-md border p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Search className="size-3.5" />
        People are looking for this
      </p>
      <p className="text-muted-foreground text-xs">
        Searches the registry could not answer, each asked by at least {MIN_DISTINCT_SEARCHERS}{" "}
        separate people.
      </p>
      <ul className="mt-1 grid gap-0.5">
        {rows.map((row) => (
          <li key={row.query} className="flex flex-wrap items-baseline gap-2 text-xs">
            <span>{row.query}</span>
            <span className="text-muted-foreground ml-auto tabular-nums">
              {row.searchers} people ·{" "}
              {row.medianResults === 0 ? "nothing found" : `${row.medianResults} found`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
