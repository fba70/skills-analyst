import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EVIDENCE_GATE, type ArchetypeDetail } from "@/server/analytics/archetype-read";

/**
 * The sample size, the pinned versions, and every version so far.
 *
 * This card exists because the rest of the page makes claims. "Curated review skills are
 * twice as likely to ship a troubleshooting section" is worth exactly as much as the
 * evidence under it, and a reader deciding whether to follow the guidance should not have to
 * go looking for how much that was.
 *
 * The three pinned versions are what make R7.2 reproducibility real: the same corpus, the
 * same extractor, the same miner and the same taxonomy give the same archetype. Printed
 * plainly rather than hidden, because a number nobody can see cannot be checked.
 *
 * The history is R3.5's convention drift in its cheapest possible form. Archetypes are
 * append-only, so every previous version is still there with its own changelog; listing them
 * costs one query and shows whether this category's conventions are settling or moving.
 */
export function EvidenceCard({ archetype }: { archetype: ArchetypeDetail }) {
  const collapsed = archetype.skillCount - archetype.distinctStructures;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence</CardTitle>
        <CardDescription>
          Derived from {archetype.distinctStructures.toLocaleString()} distinct structures
          across {archetype.sourceCount} sources.
          {collapsed > 0 ? (
            <>
              {" "}
              {archetype.skillCount.toLocaleString()} skills were considered and collapsed to{" "}
              {archetype.distinctStructures.toLocaleString()} — near-identical documents count
              once, so a generator cannot outvote a convention.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Skills considered" value={archetype.skillCount.toLocaleString()} />
          <Stat
            label="Distinct structures"
            value={archetype.distinctStructures.toLocaleString()}
            detail={`gate: ${EVIDENCE_GATE.structures}`}
          />
          <Stat
            label="Sources"
            value={String(archetype.sourceCount)}
            detail={`gate: ${EVIDENCE_GATE.sources}`}
          />
          <Stat
            label="Avg quality"
            value={
              archetype.strongThreshold !== null && archetype.weakThreshold !== null
                ? `${archetype.strongThreshold} / ${archetype.weakThreshold}`
                : "—"
            }
            detail="curated / other"
          />
        </dl>

        {/*
          The quality comparison is on this card on purpose, and it usually reads the wrong
          way round. Curated skills score at or below the rest on our own metric — which is
          the clearest available statement that the metric is not what the bands are drawn
          from, and the reason they are drawn from the publisher instead.
        */}
        <p className="text-muted-foreground text-xs">
          Bands come from <strong>who published the skill</strong> — a curated allow-list of
          repositories against everything else — not from our quality score. The score is
          bounded at 100 with thousands of skills sitting exactly there, so no band drawn
          from it has room to separate anything.
        </p>

        <div className="grid gap-2 border-t pt-4">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Pinned versions
          </h3>
          <dl className="grid grid-cols-3 gap-3">
            <Stat label="Extractor" value={archetype.extractorVersion} mono />
            <Stat label="Miner" value={archetype.minerVersion} mono />
            <Stat label="Taxonomy" value={archetype.taxonomyVersion} mono />
          </dl>
          <p className="text-muted-foreground text-xs">
            Same corpus, same three versions, same archetype. An archetype mined under a
            different taxonomy is a different claim even from identical skills.
          </p>
        </div>

        <div className="grid gap-2 border-t pt-4">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            History
          </h3>
          <ul className="grid gap-1.5">
            {archetype.history.map((entry) => (
              <li key={entry.version} className="grid gap-0.5 text-sm sm:flex sm:gap-3">
                <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums sm:w-24">
                  v{entry.version} ·{" "}
                  {entry.minedAt.toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                  })}
                </span>
                <span className="text-muted-foreground min-w-0 text-sm">
                  {entry.changelog ?? "first mine"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            Archetypes are append-only. A regeneration writes a new version and never edits
            the last one, so how the conventions moved stays readable.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  detail,
  mono = false,
}: {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={mono ? "font-mono text-sm" : "font-medium tabular-nums"}>{value}</dd>
      {detail ? <dd className="text-muted-foreground text-xs">{detail}</dd> : null}
    </div>
  );
}
