"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { History, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { restoreRevisionAction } from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { draftBlockLabel, summariseChanges, type DraftBlockChange } from "@/lib/draft-blocks";
import { REVISION_REASON_LABEL, type RevisionReason } from "@/lib/draft-blocks";

/**
 * A draft's history, as changes rather than as characters (Doc 2 R4.7).
 *
 * ## Why this reads as a list of decisions
 *
 * R4.7 has been open since the builder shipped, and the blocker was never the storage. A
 * revision over a body string is a character diff, and "3,412 characters changed" tells an
 * author nothing about whether a guardrail was deleted. Over blocks each change has a subject
 * — *this decision rule was retyped as a guardrail*, *the examples moved above the steps* —
 * and `moved` in particular has no expression in a text diff at all: it shows up as a
 * deletion and an unrelated insertion somewhere far away.
 *
 * ## Restoring goes forward
 *
 * Restore appends a new revision rather than truncating to the one restored from, so nothing
 * on this list can be destroyed by using it. That is deliberate: a history an author can lose
 * by clicking the wrong row is a history they will not click at all.
 *
 * ## Collapsed by default
 *
 * The editor above is the page. History is the thing you go looking for, so it opens on
 * demand — a native `<details>`, like the public flag form, because no dialog primitive is
 * vendored and one is not needed to show a list.
 */

export type RevisionRow = {
  revision: number;
  reason: string;
  note: string | null;
  createdAt: string;
  blockCount: number;
  changes: DraftBlockChange[];
};

export function RevisionHistory({
  draftId,
  revisions,
}: {
  draftId: string;
  revisions: RevisionRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState<number | null>(null);

  if (revisions.length === 0) return null;

  function restore(revision: number) {
    startTransition(async () => {
      const result = await restoreRevisionAction(draftId, revision);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Restored revision ${revision}. Nothing was deleted from the history.`);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" />
          History
          <span className="text-muted-foreground text-xs font-normal">
            {revisions.length} revision{revisions.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <CardDescription>
          Every save that changed the document. Restoring one adds a revision rather than
          removing the ones after it, so nothing here can be lost by using it.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-2">
        {revisions.map((row, index) => {
          const summary = summariseChanges(row.changes);
          const isCurrent = index === 0;
          return (
            <div key={row.revision} className="grid min-w-0 gap-1 rounded-md border p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  #{row.revision}
                </span>
                <Badge variant={isCurrent ? "secondary" : "outline"} className="shrink-0">
                  {REVISION_REASON_LABEL[row.reason as RevisionReason] ?? row.reason}
                </Badge>
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {new Date(row.createdAt).toLocaleString()}
                  {row.note ? ` · ${row.note}` : ""}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {row.changes.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setOpen(open === row.revision ? null : row.revision)}
                    >
                      {open === row.revision ? "Hide" : "What changed"}
                    </Button>
                  ) : null}
                  {isCurrent ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={isPending}
                      onClick={() => restore(row.revision)}
                    >
                      {isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Undo2 className="size-3.5" />
                      )}
                      Restore
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-muted-foreground text-xs">
                {row.blockCount} block{row.blockCount === 1 ? "" : "s"}
                {summary ? ` · ${summary}` : index === revisions.length - 1 ? "" : " · no change"}
              </p>

              {open === row.revision ? (
                <ul className="mt-1 grid gap-1 border-t pt-2">
                  {row.changes.map((change, i) => (
                    <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs">
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {change.kind === "edited" && change.retyped ? "retyped" : change.kind}
                      </Badge>
                      <span className="font-medium">
                        {draftBlockLabel(change.kind === "removed" ? change.from : change.to)}
                      </span>
                      {change.kind === "edited" && change.retyped ? (
                        <span className="text-muted-foreground">
                          was {draftBlockLabel(change.from)}
                        </span>
                      ) : null}
                      {change.kind === "moved" ? (
                        <span className="text-muted-foreground tabular-nums">
                          {change.from.order + 1} → {change.to.order + 1}
                        </span>
                      ) : null}
                      <span className="text-muted-foreground min-w-0 truncate">
                        {(change.kind === "removed" ? change.from : change.to).text
                          .replace(/\s+/g, " ")
                          .slice(0, 90) || "empty"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
