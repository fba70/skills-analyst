"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  publishDraftAction,
  regenerateDraftAction,
} from "@/app/(protected)/build/actions";
import { EXPORT_DIALECTS } from "@/lib/dialects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * What an author can do with a finished draft: rewrite it, take it, or publish it.
 *
 * The three are deliberately different weights. Rewriting is one model call and reversible.
 * Exporting is free and changes nothing. Publishing writes to the corpus and runs the real
 * validation pipeline, so it is the primary button and the only one that says what it will
 * do before doing it.
 */
export function DraftActions({
  draftId,
  slug,
  busy,
  canPublish,
  blocked,
  publishedSlug,
}: {
  draftId: string;
  slug: string;
  busy: boolean;
  canPublish: boolean;
  blocked: boolean;
  publishedSlug: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Selected formats for export. The Agent Skills standard is on by default because it is
  // what the corpus is made of and what most consumers expect.
  const [formats, setFormats] = useState<string[]>(["anthropic_skill"]);

  function regenerate() {
    startTransition(async () => {
      const result = await regenerateDraftAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.data.refused) toast.warning("The assistant declined to write this one.");
      else toast.success("Rewritten.");
      router.refresh();
    });
  }

  function publish() {
    startTransition(async () => {
      const result = await publishDraftAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      // Quarantined is a real outcome, not a failure of the publish: the skill exists, it
      // is just not served. Saying so plainly beats a success toast over a hidden skill.
      if (result.data.status === "quarantined") {
        toast.warning(`Published but quarantined: ${result.data.reasons.join(", ")}`);
      } else {
        toast.success(`Published · quality ${result.data.qualityScore}/100`);
      }
      router.refresh();
    });
  }

  const exportHref = `/api/drafts/${draftId}/export?${formats
    .map((f) => `dialect=${encodeURIComponent(f)}`)
    .join("&")}`;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export</CardTitle>
          <CardDescription>
            One draft, one archive, a directory per format. Carries a receipt with the
            archetype version and the validation report hash. Two exports of an unchanged
            draft are byte-identical.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ul className="grid gap-2">
            {EXPORT_DIALECTS.map((dialect) => (
              <li key={dialect.id} className="flex items-center gap-2 text-sm">
                <input
                  id={`fmt-${dialect.id}`}
                  type="checkbox"
                  checked={formats.includes(dialect.id)}
                  onChange={(e) =>
                    setFormats((prev) =>
                      e.target.checked
                        ? [...prev, dialect.id]
                        : prev.filter((f) => f !== dialect.id),
                    )
                  }
                  className="accent-primary size-4"
                />
                <label htmlFor={`fmt-${dialect.id}`} className="flex flex-wrap gap-2">
                  {dialect.label}
                  <span className="text-muted-foreground text-xs">{dialect.hint}</span>
                </label>
              </li>
            ))}
          </ul>
          <div>
            {/* A plain link, not a fetch-and-blob: the browser streams the archive and the
                filename comes from Content-Disposition. */}
            <Button asChild size="sm" variant="outline" disabled={formats.length === 0}>
              <a href={exportHref}>
                <Download className="size-4" />
                Download {formats.length > 1 ? `${formats.length} formats` : "it"}
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Publish
            {publishedSlug ? (
              <Badge variant="secondary" className="text-[11px]">
                published
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Puts the skill in your workspace and runs it through the{" "}
            <strong>same validation pipeline as every skill we ingest</strong> — no
            privileged path. Its archetype version is recorded as lineage.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {publishedSlug ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <CheckCircle2 className="text-primary size-4" />
              <Link
                href={`/skills/${publishedSlug}`}
                className="underline underline-offset-4"
              >
                View the published skill
              </Link>
            </div>
          ) : (
            <>
              <Button onClick={publish} disabled={isPending || busy || !canPublish || blocked}>
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Upload className="size-4" />
                )}
                Publish {slug}
              </Button>
              {blocked ? (
                <p className="text-destructive text-xs">
                  A blocking finding stops publication (R4.5). Export still works — a local
                  copy is your business; the corpus is not.
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Validation runs again on the stored bytes. A skill that fails is kept and
                  quarantined with reasons, not discarded.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={regenerate} disabled={isPending || busy}>
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Write it again
        </Button>
        <span className="text-muted-foreground text-xs">
          Uses the inputs already saved on this draft. One model call.
        </span>
      </div>
    </div>
  );
}
