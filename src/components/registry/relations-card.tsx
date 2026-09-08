import Link from "next/link";
import { AlertTriangle, Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RELATION_META, type Relation } from "@/lib/relations";
import type { RelationView } from "@/server/analytics/relations";

/**
 * How this skill relates to the rest of the corpus (Doc 6 RK.3, plan step E2).
 *
 * ## Conflicts are their own card, above the rest
 *
 * Every other edge here is navigation — something else worth reading. A conflict is a warning, and
 * mixing the two would put "installing both breaks your agent" in a list next to "you might also
 * like". They are rendered as two cards for that reason and no other.
 *
 * ## A conflict warns and never blocks
 *
 * It is a measurement over two documents, not a licence or a takedown. The reader may have good
 * reason to install both, and the refusals in this codebase are for things nobody may do. So the
 * evidence is quoted — the two rules that disagree — and the judgement is left with them.
 */
export function RelationsCard({ view }: { view: RelationView }) {
  if (view.relations.length === 0 && view.conflicts.length === 0) return null;

  return (
    <>
      {view.conflicts.length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="text-destructive size-4" />
              Conflicts with {view.conflicts.length} other skill
              {view.conflicts.length === 1 ? "" : "s"}
            </CardTitle>
            <CardDescription>
              Their rules contradict this one&rsquo;s. Both documents are individually valid —
              nothing in validation can see this, because it is a fact about the pair. Installing
              both would give an agent instructions it cannot follow at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {view.conflicts.map((relation) => (
              <div key={relation.slug} className="grid gap-0.5 rounded-md border p-3">
                <Link
                  href={`/skills/${relation.slug}`}
                  className="text-sm font-medium hover:underline"
                >
                  {relation.name}
                </Link>
                {/*
                  The evidence, quoted. "These conflict" without saying how is a claim a reader
                  can neither check nor act on, and this one is about somebody else's work.
                */}
                {relation.detail ? (
                  <p className="text-muted-foreground text-xs">{relation.detail}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {view.relations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="size-4" />
              Related
            </CardTitle>
            <CardDescription>
              Similarity is measured from the embedding index and resolved live, so it reflects the
              corpus as it stands rather than a snapshot.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1.5">
            {view.relations.map((relation) => (
              <Row key={`${relation.kind}-${relation.slug}`} relation={relation} />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function Row({ relation }: { relation: Relation }) {
  const meta = RELATION_META[relation.kind];
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
      <Badge variant={meta.caution ? "outline" : "secondary"} className="shrink-0 font-normal">
        {meta.label}
      </Badge>
      <Link href={`/skills/${relation.slug}`} className="min-w-0 truncate hover:underline">
        {relation.name}
      </Link>
      {relation.similarity !== null ? (
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {relation.similarity.toFixed(3)}
        </span>
      ) : null}
    </div>
  );
}
