import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldOff } from "lucide-react";

import { BlockEditor } from "@/components/builder/block-editor";
import { EvalPanel } from "@/components/builder/eval-panel";
import { DistillPanel } from "@/components/builder/distill-panel";
import { Interview } from "@/components/builder/interview";
import { MatrixPanel } from "@/components/builder/matrix-panel";
import { OptimiserPanel } from "@/components/builder/optimiser-panel";
import { ParametersPanel } from "@/components/builder/parameters-panel";
import { TriggerLab } from "@/components/builder/trigger-lab";
import { RevisionHistory } from "@/components/builder/revision-history";
import { DraftActions } from "@/components/builder/draft-actions";
import { ActivationCostBadge } from "@/components/registry/activation-cost";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDraftBlocks, listDraftRevisions } from "@/server/builder/blocks";
import { coverageFor } from "@/server/builder/parameters";
import { proposalsFor } from "@/server/evals/rule-cases";
import { contentHashOf, evalParentFor, evalStates } from "@/server/evals/store";
import { getSession, listSessions } from "@/server/interview/session";
import { alignmentForDraft } from "@/server/builder/alignment";
import { blockDeviations } from "@/server/builder/deviation";
import { getDraft } from "@/server/builder/drafts";
import { listDistillRuns } from "@/server/distill/run";
import { hasEntitlement } from "@/server/dal/entitlements";
import { getSkillsByIds } from "@/server/dal/skills";
import { requireSession } from "@/server/dal/session";
import { estimateTokens } from "@/lib/tokens";
import { attributionLine, IMPORT_SOURCE_META, isImportSource } from "@/lib/improve";
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
  const session = await requireSession();
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

  /*
   * R4.3's deviation marks, at block granularity.
   *
   * Computed on read rather than stored on the draft, and that is the same argument the
   * published slug above makes: an archetype is re-mined and a stored comparison would go on
   * describing a version of the guidance nobody is served any more. Free — the extractor is
   * pure rules over a string already in memory.
   */
  const deviations = draft.body ? await blockDeviations(draft.body, draft.archetypeCategory) : null;

  /*
   * The blocks the body was rendered from (plan step C1).
   *
   * A draft written before this step has a body and no rows, so the list comes back empty
   * and the editor says so rather than showing a document with nothing in it — the body is
   * still displayed above, and re-generating imports it. Backfilling on read was the
   * alternative and is worse: a GET that silently writes rows is a GET that can fail on a
   * page nobody was asking to change anything on.
   */
  const orgId = session.session.activeOrganizationId;
  const [blocks, revisions, sessions, distillRunRows, distillEntitled, evalCases, alignment] = orgId
    ? await Promise.all([
        getDraftBlocks(draft.id, orgId),
        listDraftRevisions(draft.id, orgId),
        listSessions(draft.id, orgId),
        listDistillRuns(draft.id, orgId),
        /* `hasEntitlement`, not `require`: a free author is not doing anything wrong. */
        hasEntitlement(orgId, "distill"),
        /*
         * The parent moves on publish — `publishDraft` re-points every case onto the skill — so
         * asking for `{ draftId }` after publication finds nothing and the panel reads as data
         * loss. One helper decides, at every call site that needs it.
         */
        evalStates(evalParentFor(draft), orgId),
        /*
         * RD.8's three-source comparison, derived on read like the deviation marks above. Free:
         * the extractor is rules over a string, and the capability surface is rules over files
         * already stored on the draft. Nothing here gates publishing.
         */
        alignmentForDraft(draft.id, orgId),
      ])
    : [[], [], [], [], false, [], null];

  /*
   * `hasEntitlement`, not `requireEntitlement`. A free-tier author is not doing anything wrong
   * by opening their own draft, and throwing here would turn the absence of a subscription into
   * a 500 on a page that is mostly free-tier surfaces. The panel says what the gate is instead.
   */
  const evalEntitled = orgId
    ? await (async () => {
        const { hasEntitlement } = await import("@/server/dal/entitlements");
        return hasEntitlement(orgId, "eval-lab");
      })()
    : false;

  /*
   * The newest *active* interview, resumed in place (Doc 6 RW.4).
   *
   * Resumed rather than restarted, because the transcript is the expensive part: an author who
   * reloads the page fifteen turns into describing an exception must not lose it, and the turns
   * are already rows. An ended session is history and does not reopen — the technique buttons
   * come back instead.
   */
  const activeSession = orgId
    ? await (async () => {
        const open = sessions.find((row) => row.status === "active");
        return open ? getSession(open.id, orgId) : null;
      })()
    : null;

  /*
   * Parameters, rule states and coverage (Doc 7 RD.1–RD.3). Derived on read, like the deviation
   * marks: a stored coverage figure would go on describing rules the author has since edited.
   * Free — arithmetic over rows already fetched for the editor.
   */
  const designer = orgId ? await coverageFor(draft.id, orgId) : null;

  /*
   * What those rules would test (Doc 7 RD.4). Derived like everything else on this page, and
   * free: a proposal is a render of a row the editor already loaded, so it calls no model and
   * costs nothing until somebody accepts one and runs it.
   */
  const ruleCases = orgId ? await proposalsFor(draft, orgId) : null;

  return (
    <div className="grid min-w-0 gap-6">
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
          {/*
            The author's own activation cost, computed from the draft body with the same
            estimator the registry uses on a published skill (Doc 6 RW.9). Sharing the
            component is the point: an author asking "is mine bigger than the ones I copied
            from?" has to be reading one number computed one way.

            Estimated live rather than stored, because a draft has no structural fingerprint
            — that only exists once it is published and the extractor has run over it.
          */}
          {draft.body ? <ActivationCostBadge tokens={estimateTokens(draft.body)} /> : null}
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
        {draft.summary ? (
          <p className="text-muted-foreground max-w-3xl">{draft.summary}</p>
        ) : null}
      </header>

      {/*
        The obligation, where the work is happening (R5.6, plan step C6).

        A fork carries its upstream's licence and credit into anything published from it, and the
        author needs that in front of them while they edit rather than as a surprise on the
        publish screen. `attributionLine` is the single definition of the credit — the same one
        the publish path carries into the archive's ATTRIBUTION.txt — so the draft page and the
        download cannot phrase one legal fact two ways.
      */}
      {draft.importAttribution && isImportSource(draft.importSource) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {IMPORT_SOURCE_META[draft.importSource].label}
            </CardTitle>
            <CardDescription>{IMPORT_SOURCE_META[draft.importSource].blurb}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <p className="text-muted-foreground">{attributionLine(draft.importAttribution)}</p>
            <p className="text-muted-foreground text-xs">
              Publishing from this draft inherits the {draft.importAttribution.posture.replace(/_/g, " ")}{" "}
              posture, so every download of your version carries the credit too.
            </p>
          </CardContent>
        </Card>
      ) : null}

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

      {/*
        The editor is the document (plan steps C1, C1b).

        It used to be a `<pre>` holding the generated string — an honest way to show a body
        and no way at all to change one. The blocks are the source now and the body is their
        render, so this is both the view and the edit surface, and there is exactly one of
        them. The archetype comparison lives inside it so its missing-block list can put a
        block into the draft.
      */}
      {blocks.length > 0 || !draft.body ? (
        <BlockEditor
          draftId={draft.id}
          blocks={blocks}
          deviations={deviations}
          alignment={alignment}
          disabled={draft.status === "generating"}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">SKILL.md</CardTitle>
            <CardDescription>
              Written by {draft.model ?? "the assistant"} before this draft was split into
              blocks. Re-generate to edit it block by block.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Source, not rendered markdown: this is the artifact the author ships, and
                formatting it would hide the headings that decide whether it works. */}
            <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-4 text-xs leading-relaxed whitespace-pre-wrap">
              {draft.body}
            </pre>
          </CardContent>
        </Card>
      )}

      {/*
        Directly under the editor, because it is about the document's own structure rather than a
        verdict on it. Validation and evals below answer "may this ship" and "does this work";
        this answers "is the decision written down completely", which is the author's question
        while they are still writing.
      */}
      {designer && blocks.length > 0 ? (
        <ParametersPanel
          draftId={draft.id}
          parameters={designer.parameters}
          rules={designer.rules}
          coverage={designer.coverage}
          disabled={draft.status === "generating"}
        />
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

      {/*
        Evals below validation, because they answer the harder question and take longer to
        read. Validation is a gate on form and is either clear or not; this is evidence about
        behaviour, and putting it above the gate would suggest the gate depends on it. It does,
        but only for a regression — which the panel says in its own words.
      */}
      <EvalPanel
        draftId={draft.id}
        cases={evalCases}
        proposals={ruleCases}
        contentHash={contentHashOf(draft.body ?? "")}
        entitled={evalEntitled}
        canRun={Boolean(draft.body)}
      />

      {/*
        The optimiser is last of the eval surfaces, because it is the only one that proposes a
        change to the document rather than reporting on it — and because it needs the cases the
        panels above it exist to accumulate.
      */}
      {draft.body ? (
        <OptimiserPanel
          draftId={draft.id}
          hasCases={evalCases.length > 0}
          currentTokens={estimateTokens(draft.body)}
        />
      ) : null}

      {/*
        The matrix sits with the trigger lab, under the evals both read. It is the last panel
        that costs money and the only one that can produce an outcome signal, so it is also the
        last one an author reaches — by the time it is worth pressing, the document is finished.
      */}
      {evalCases.some((c) => c.kind === "golden-task") ? (
        <MatrixPanel
          draftId={draft.id}
          goldenTasks={evalCases.filter((c) => c.kind === "golden-task").length}
          published={Boolean(draft.publishedSkillId)}
        />
      ) : null}

      {/*
        The trigger lab sits directly under the evals it reads, because it is the same probes
        seen a level up — rates rather than individual verdicts. Its own panel rather than a
        section inside that one, because the collision half asks a question about the corpus
        rather than about this document, and folding the two together would suggest a single
        verdict where there are deliberately two.
      */}
      {evalCases.some(
        (c) => c.kind === "should-trigger" || c.kind === "should-not-trigger",
      ) ? (
        <TriggerLab draftId={draft.id} hasProbes />
      ) : null}

      {/*
        The interview sits last of the working panels, below every verdict on the draft.

        The three above it — validation, evals, and the archetype comparison inside the editor —
        all describe what exists. This is how more of it comes to exist, and it is the only one
        an author scrolls to deliberately rather than reads on the way past. An accepted block
        appears back up in the editor, which is the confirmation that answering did something.
      */}
      {/*
        Below Interview, and the pairing is the point.

        Interview asks for knowledge the author has not written down; Distill takes it from work
        that already happened. They produce the same candidate rows and share one accept path, so
        an author who tries both is not learning two interfaces — and the second is the one that
        costs nothing to attempt on a session that already exists.
      */}
      <DistillPanel
        draftId={draft.id}
        entitled={distillEntitled as boolean}
        runs={(distillRunRows as Awaited<ReturnType<typeof listDistillRuns>>).map((run) => ({
          id: run.id,
          label: run.label,
          createdAt: run.createdAt.toISOString(),
          turnsRead: run.turnsRead,
          humanTurns: run.humanTurns,
          toolResultsDropped: run.toolResultsDropped,
          windowsFound: run.windowsFound,
          windowsSent: run.windowsSent,
          candidates: run.candidates.map((candidate) => ({
            id: candidate.id,
            type: candidate.type,
            text: candidate.text,
            decision: candidate.decision,
          })),
        }))}
      />

      <Interview
        draftId={draft.id}
        sessionId={activeSession?.id ?? null}
        initialTurns={
          activeSession
            ? activeSession.turns.map((turn) =>
                turn.role === "author"
                  ? { role: "author" as const, text: turn.text }
                  : {
                      role: "assistant" as const,
                      text: turn.text,
                      candidates: turn.candidates.map((c) => ({
                        id: c.id,
                        type: c.type,
                        text: c.editedText ?? c.text,
                        decision: c.decision,
                      })),
                    },
              )
            : []
        }
        budget={activeSession?.budget ?? null}
      />

      {/*
        History below validation, because that is the order of consequence again: validation
        decides whether this can be published, and history is a thing an author reaches for
        when they already know something is wrong.
      */}
      <RevisionHistory
        draftId={draft.id}
        revisions={revisions.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))}
      />

      <DraftActions
        draftId={draft.id}
        slug={draft.slug}
        busy={draft.status === "generating"}
        canPublish={draft.status === "ready"}
        blocked={draft.validation?.blocked ?? false}
        publishedSlug={publishedSlug}
      />
    </div>
  );
}
