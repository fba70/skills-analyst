import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldOff } from "lucide-react";

import { DraftActions } from "@/components/builder/draft-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDraft } from "@/server/builder/drafts";
import { getSkillsByIds } from "@/server/dal/skills";
import { requireSession } from "@/server/dal/session";
import { labelFor } from "@/server/taxonomy/vocabulary";

export const metadata: Metadata = { title: "Draft" };

/**
 * One draft: what the assistant wrote, and what the analyzers made of it.
 *
 * The validation panel is not decoration. R4.5 gates publishing on the full pipeline, and
 * showing the findings here — from the same analyzers the registry runs — is what stops the
 * builder producing skills held to a lower standard than the corpus it publishes into.
 *
 * A refusal (R5.5) renders instead of the body, with the reason the assistant gave. It is
 * an answer, not an error: the inputs are still on the draft and still editable.
 */
export default async function DraftPage(props: PageProps<"/build/[id]">) {
  await requireSession();
  const { id } = await props.params;
  // Org-scoped in the DAL: an id from another workspace resolves to nothing, so this is a
  // 404 rather than a permission error — which is also the right thing to leak.
  const draft = await getDraft(id);
  if (!draft) notFound();

  // Resolved rather than stored on the draft: a published skill can be renamed or withdrawn,
  // and a stale slug would be a link to nowhere on the page that created it.
  const publishedSlug = draft.publishedSkillId
    ? ((await getSkillsByIds([draft.publishedSkillId]))[0]?.slug ?? null)
    : null;

  return (
    <div className="grid min-w-0 max-w-4xl gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/build">
            <ArrowLeft className="size-4" />
            Build
          </Link>
        </Button>
      </div>

      <header className="grid gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{draft.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{labelFor("function", draft.archetypeCategory)}</Badge>
          {draft.domainCategory ? (
            <Badge variant="outline">{labelFor("domain", draft.domainCategory)}</Badge>
          ) : null}
          <Badge variant={draft.status === "ready" ? "secondary" : "outline"}>
            {draft.status}
          </Badge>
          {draft.qualityScore !== null ? (
            <Badge variant="outline" className="tabular-nums">
              {draft.qualityScore}/100
            </Badge>
          ) : null}
          {draft.archetypeVersion !== null ? (
            <Badge variant="outline" className="text-muted-foreground">
              archetype v{draft.archetypeVersion}
            </Badge>
          ) : null}
        </div>
        {draft.summary ? <p className="text-muted-foreground">{draft.summary}</p> : null}
      </header>

      {draft.status === "failed" ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldOff className="text-destructive size-4" />
              Not written
            </CardTitle>
            <CardDescription>{draft.failureReason}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Your inputs are kept. Edit the purpose or the section notes and try again.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {draft.body ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">SKILL.md</CardTitle>
            <CardDescription>
              Written by {draft.model ?? "the assistant"} from your inputs and the{" "}
              {labelFor("function", draft.archetypeCategory).toLowerCase()} archetype.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Rendered as source, not as markdown: this is the artifact the author will
                ship, and showing it formatted would hide the headings and frontmatter that
                decide whether it works. */}
            <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-4 text-xs leading-relaxed whitespace-pre-wrap">
              {draft.body}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {draft.validation ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Validation</CardTitle>
            <CardDescription>
              The same free analyzers the registry runs — structural lint, secret scan,
              injection scan, capability surface.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {draft.validation.findings.length === 0 ? (
              <p className="text-sm">No findings. This would pass validation as it stands.</p>
            ) : (
              <ul className="grid gap-2">
                {draft.validation.findings.map((finding, index) => (
                  <li key={`${finding.reason}-${index}`} className="grid gap-0.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-xs">{finding.reason}</code>
                      <Badge variant="outline" className="text-[11px]">
                        {finding.severity}
                      </Badge>
                      <span className="text-muted-foreground text-xs">{finding.analyzer}</span>
                    </div>
                    <p className="text-muted-foreground text-xs">{finding.message}</p>
                  </li>
                ))}
              </ul>
            )}
            {draft.validation.blocked ? (
              <p className="text-destructive text-sm">
                A finding at this severity would block publication.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <DraftActions
        draftId={draft.id}
        slug={draft.slug}
        busy={draft.status === "generating"}
        canPublish={Boolean(draft.body)}
        blocked={draft.validation?.blocked ?? false}
        publishedSlug={publishedSlug}
      />
    </div>
  );
}
