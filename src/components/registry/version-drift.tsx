import { History } from "lucide-react";

import { DRIFT_META } from "@/lib/versions";
import type { VersionDrift } from "@/server/skills/versions";

/**
 * A newer version has shipped since this was written (Doc 7 RD.10).
 *
 * RK.2 promised *"your skill teaches Next 15 idioms; 16 changed X"*; link rot and review dates
 * shipped and this did not, because nothing knew which projects a skill referenced.
 *
 * ## It is information, and the card says so in the module's own words
 *
 * The reasoning comes from `DRIFT_META.behind.blurb` rather than being written again here —
 * one sentence, in the leaf module, so the panel and this card cannot come to disagree about
 * what drift means. **A skill teaching one version's idioms is exactly right for a codebase on
 * that version.** So this never appears as a warning, never scores, and never reaches the
 * lifecycle: `stale` remains the only freshness signal that changes a state, because that one
 * is a governance decision a person made.
 *
 * ## There is no "up to date" tick, deliberately
 *
 * Most skills pin nothing at all, and the overwhelming majority of what the pin detector finds
 * is not a version of anything the vocabulary tracks. A green tick over that silence would be
 * the `archetypes --blocks` misreading in a new place — a confident answer to a question
 * nobody asked. The card is absent unless there is something to say.
 */

export function VersionDriftCard({ drifts }: { drifts: VersionDrift[] }) {
  if (drifts.length === 0) return null;

  return (
    <section className="grid gap-2 rounded-lg border p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <History aria-hidden className="size-4" />
        {DRIFT_META.behind.label}
      </h2>

      <ul className="grid gap-1">
        {drifts.map((drift) => (
          <li key={drift.subject} className="text-sm">
            <span className="font-medium">{drift.label}</span>
            <span className="text-muted-foreground">
              {" "}
              — this names {drift.pinned}; current is {drift.current}
              {drift.releasedAt
                ? `, released ${drift.releasedAt.toISOString().slice(0, 10)}`
                : ""}
              .
            </span>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">{DRIFT_META.behind.blurb}</p>
    </section>
  );
}
