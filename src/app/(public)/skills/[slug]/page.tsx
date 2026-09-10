import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ActivationCostBadge } from "@/components/registry/activation-cost";
import { CapabilitySurface } from "@/components/registry/capability-surface";
import { LifecycleBadge, LifecycleNotice } from "@/components/registry/lifecycle-notice";
import { ReportForms } from "@/components/registry/report-forms";
import { WatchButton } from "@/components/registry/watch-button";
import { Explain, ExplainLink } from "@/components/registry/explain";
import { ConsistencyCard } from "@/components/registry/consistency-card";
import { ImpactCard } from "@/components/registry/impact-card";
import { RelationsCard } from "@/components/registry/relations-card";
import { DownloadCard } from "@/components/registry/download-card";
import { EndorsementCard } from "@/components/registry/endorsement-card";
import { ProvenanceCard } from "@/components/registry/provenance-card";
import {
  OverallVerdict,
  VerdictBadge,
  type VerdictResult,
} from "@/components/registry/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WithdrawalNotice } from "@/components/registry/withdrawal-notice";
import { minedCategories } from "@/server/analytics/archetype-read";
import { outcomeCollectionStart, outcomesForSkill } from "@/server/analytics/outcomes";
import { relationsFor } from "@/server/analytics/relations";
import { endorseAffordance, endorsementsFor } from "@/server/curation/maintainers";
import { isWatching } from "@/server/notifications/watch";
import { withdrawalNotice } from "@/server/compliance/takedown";
import { getSession } from "@/server/dal/session";
import { getSkillBySlug } from "@/server/dal/skills";
import { labelFor } from "@/server/taxonomy/vocabulary";

export async function generateMetadata(
  props: PageProps<"/skills/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const skill = await getSkillBySlug(slug);
  return { title: skill?.name ?? "Skill" };
}

export default async function SkillPage(props: PageProps<"/skills/[slug]">) {
  // Public (R8.1): provenance, licence and verdicts are the trust surfaces, and gating
  // them behind an account defeats the point of publishing them.
  const { slug } = await props.params;
  const skill = await getSkillBySlug(slug);
  if (!skill) notFound();

  /**
   * The way back out to what the corpus knows about this kind of skill.
   *
   * Checked rather than assumed: one function category has no archetype, and a link to a
   * page that 404s is worse than no link. `minedCategories` is one cheap distinct query.
   */
  /**
   * A withdrawn skill keeps its page and loses its content (R7.5).
   *
   * Only queried when the status says so — this is a compliance lookup on a hot public
   * page, and every other skill would be paying for a row that does not exist.
   */
  const withdrawal =
    skill.status === "withdrawn" ? await withdrawalNotice(skill.id) : null;

  /*
   * RK.7's per-skill half (plan step E4).
   *
   * Reachability is already decided: `getSkillBySlug` is org-scoped, so a private skill's
   * signals are only readable by somebody who could already see the skill. `outcome_signals` has
   * an open read policy on purpose — cross-organisation aggregation is what `archetypeOutcomes`
   * is for — and it is safe because of the column list: a kind, a value, a day and a digest, with
   * no free text and no caller identity.
   */
  const session = await getSession();

  const [outcomes, collectionStart, relations, endorsement, affordance, watching] =
    await Promise.all([
    outcomesForSkill(skill.id),
    outcomeCollectionStart(),
    /*
     * The graph (RK.3). Two of its four kinds are resolved live rather than stored — similarity
     * from the A6 index and supersession from A4's own column — so this is three cheap queries
     * and no snapshot that can go stale.
     */
    relationsFor(skill.id),
    /*
     * RK.6's endorsements (plan step E5), resolved live against current maintainership. It is a
     * FREE_FOREVER surface, so it renders for an anonymous reader exactly as it does for anybody
     * else — the absence of an endorsement is the part a reader most needs, and putting that
     * behind an account would be a registry that gives away its good news and charges for the
     * warning.
     */
    endorsementsFor(skill.id),
    /*
     * Whether *this* viewer may endorse, resolved on the server from live standing. Never a role
     * inferred in the browser: the sidebar's admin flag takes the same posture, and the action
     * re-checks anyway because a control is a hint and a POST is the operation.
     */
    endorseAffordance(session?.user.id ?? null, skill.id),
    /*
     * R8.7's watch state. Resolved on the server like every other affordance here, and false for
     * an anonymous reader — the button is absent rather than disabled, because a control that
     * exists only to say you cannot use it is worse than the space it takes.
     */
    session ? isWatching(session.user.id, "skill", skill.id) : Promise.resolve(false),
  ]);

  const mined = await minedCategories();
  const archetypeCategory = skill.categories.find(
    (category) => category.axis === "function" && mined.has(category.value),
  );

  const findings = skill.verdicts.flatMap((verdict) =>
    verdict.findings.map((finding) => ({ ...finding, analyzer: verdict.analyzer })),
  );

  return (
    <div className="grid min-w-0 gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/skills">
            <ArrowLeft className="size-4" />
            Registry
          </Link>
        </Button>
      </div>

      <header className="grid gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{skill.name}</h1>
        {skill.summary ? (
          <p className="text-muted-foreground max-w-3xl">{skill.summary}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Explain anchor="validation">
            <OverallVerdict verdicts={skill.verdicts} status={skill.status} />
          </Explain>
          {/*
            Wrapped, not trailed by a "?" — the badge is already what a reader points at
            when they want to know what it means, so making it the target costs no visual
            weight. Safe here because nothing on this page wraps these in a link; the
            registry list does, which is why it gets a plain link near its filters instead.
          */}
          <Explain anchor="quality">
            <Badge variant="outline">Quality {skill.qualityScore ?? "—"}/100</Badge>
          </Explain>
          <Badge variant="outline">{skill.dialect.replace(/_/g, " ")}</Badge>
          {skill.fileCount ? (
            <Badge variant="outline">
              {skill.fileCount} file{skill.fileCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
          {/*
            Activation cost sits with quality and file count because it is the same class of
            fact — something a reader weighs before installing. Absent, not zero, when the
            version has no fingerprint yet, so a re-extract in progress reads as silence
            rather than as a measurement of nothing.

            The null check is here rather than only inside the badge: `Explain` wraps its
            child in a link, and a link wrapping nothing is an invisible tab stop.
          */}
          {skill.tokenEstimate !== null ? (
            <Explain anchor="cost">
              <ActivationCostBadge tokens={skill.tokenEstimate} />
            </Explain>
          ) : null}
          {/* Same guard, same reason: Explain wraps a link, and a link around nothing is an
              invisible tab stop. */}
          {skill.lifecycle !== null ? (
            <Explain anchor="lifecycle">
              <LifecycleBadge state={skill.lifecycle} />
            </Explain>
          ) : null}
        </div>

        {skill.categories.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Linked, not decorative: a category on a skill page should be a way into the
                rest of that category, which is most of what a taxonomy is for. */}
            {skill.categories.map((category) => (
              <Link
                key={`${category.axis}:${category.value}`}
                href={`/skills?category=${category.axis}:${category.value}`}
              >
                <Badge
                  variant={category.axis === "function" ? "secondary" : "outline"}
                  className="hover:bg-accent transition-colors"
                >
                  {labelFor(category.axis as "function" | "domain", category.value)}
                </Badge>
              </Link>
            ))}
            {/*
              The badges keep their existing link into the registry — browsing the rest of a
              category is more useful than a definition, and taking that away to explain the
              word would be a bad trade. The definition gets its own quiet link.
            */}
            <ExplainLink anchor="categories">What are categories?</ExplainLink>
          </div>
        ) : null}

        {archetypeCategory ? (
          <p className="text-muted-foreground text-sm">
            <Link
              href={`/archetypes/${archetypeCategory.value}`}
              className="hover:text-foreground underline underline-offset-4"
            >
              See what the corpus says a{" "}
              {labelFor("function", archetypeCategory.value).toLowerCase()} skill looks like
            </Link>
          </p>
        ) : null}
      </header>

      {/*
        Above the download and above the consistency card, because when a skill has been
        superseded the most useful thing this page can do is send the reader to the
        replacement — and that is only true if they see it before deciding.
      */}
      <LifecycleNotice
        state={skill.lifecycle}
        note={skill.lifecycleNote}
        reviewBy={skill.reviewBy}
        supersededBy={skill.supersededBy}
      />

      <ConsistencyCard verdicts={skill.verdicts} />

      {/*
        After the verdicts, because those decide whether the skill is servable at all and this
        only describes what happened to it afterwards. Before the download card, because a reader
        deciding whether to take it wants the evidence first.
      */}
      {/*
        Above impact, because a conflict is a warning and impact is a statistic. A reader deciding
        whether to take this skill needs to know it contradicts another one before they read how
        many people have downloaded it.
      */}
      <RelationsCard view={relations} />

      {/*
        Between the graph and the statistics, which is where a human judgement belongs: after the
        warnings that are facts about other documents, before the counts that are facts about
        strangers. It is deliberately not in the badge row at the top — a count of endorsements
        beside the quality score would read as another measurement, and the whole point is that
        it is not one.
      */}
      <EndorsementCard
        slug={skill.slug}
        endorsements={endorsement.endorsements.map((row) => ({
          userId: row.userId,
          name: row.name,
          note: row.note,
          at: row.at.toISOString(),
          categoryLabel: row.categoryLabel,
          stale: row.stale,
        }))}
        eligible={endorsement.eligible}
        coveredCategories={endorsement.coveredCategories}
        viewerMayEndorse={affordance.eligible}
        viewerHasEndorsed={affordance.already}
      />

      <ImpactCard outcomes={outcomes} collectionStart={collectionStart} />

      {skill.status === "withdrawn" ? (
        /*
         * The notice replaces the download card rather than sitting beside it. A disabled
         * download button next to "withdrawn on request" invites the reader to look for the
         * way around it; there isn't one, and the interface should not imply there is.
         *
         * The verdicts below stay. They are our own derived record of what we found, not
         * the author's text, and they are what makes the permalink worth resolving.
         */
        <WithdrawalNotice
          grounds={withdrawal?.grounds ?? "other"}
          decidedAt={withdrawal?.decidedAt ?? null}
          originUrl={
            (skill.provenance as { sourceUrl?: string })?.sourceUrl ?? skill.sourceUrl ?? null
          }
        />
      ) : (
      <DownloadCard
        slug={skill.slug}
        status={skill.status}
        redistribution={skill.redistribution}
        contentStored={skill.contentStored}
        licenseSpdx={skill.licenseSpdx}
        originUrl={
          (skill.provenance as { sourceUrl?: string })?.sourceUrl ?? skill.sourceUrl ?? null
        }
        fileCount={skill.fileCount}
      />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-baseline gap-3">
            Validation
            <ExplainLink anchor="validation">How validation works</ExplainLink>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ul className="grid gap-2">
            {skill.verdicts.map((verdict) => (
              <li
                key={verdict.analyzer}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="font-medium">{verdict.analyzer.replace(/-/g, " ")}</span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs">
                    v{verdict.analyzerVersion}
                  </span>
                  <VerdictBadge result={verdict.result as VerdictResult} />
                </span>
              </li>
            ))}
          </ul>

          {findings.length > 0 ? (
            <div className="grid gap-2 border-t pt-4">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Findings
              </p>
              <ul className="grid gap-2">
                {findings.map((finding, index) => (
                  <li key={`${finding.reason}-${index}`} className="grid gap-0.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-xs">{finding.reason}</code>
                      <Badge variant="outline" className="text-[11px]">
                        {finding.severity}
                      </Badge>
                      {finding.file ? (
                        <span className="text-muted-foreground text-xs">
                          {finding.file}
                          {finding.line ? `:${finding.line}` : ""}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">{finding.message}</p>
                    {finding.excerpt ? (
                      /* Evidence can quote hostile content, so it is rendered as inert
                         text — never markup, never a link. */
                      <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
                        {finding.excerpt}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground border-t pt-4 text-sm">
              No findings from any analyzer.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-baseline gap-3">
            Capability surface
            <ExplainLink anchor="capabilities">What are capabilities?</ExplainLink>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CapabilitySurface surface={skill.surface} undocumented={skill.undocumented} />
        </CardContent>
      </Card>

      {skill.canonicalOf ? (
        <Card>
          <CardHeader>
            <CardTitle>Clustered under another entry</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">
              This skill is {(skill.canonicalOf.similarity * 100).toFixed(1)}% identical to{" "}
              <Link
                href={`/skills/${skill.canonicalOf.slug}`}
                className="text-foreground underline underline-offset-4"
              >
                {skill.canonicalOf.name}
              </Link>
              , which is served as the canonical entry. This copy keeps its own provenance
              and attribution.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {skill.variants.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {skill.variants.length} near-duplicate
              {skill.variants.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <p className="text-muted-foreground text-sm">
              Other copies of this skill found across sources. Each keeps its own origin and
              attribution; only this entry is listed in search.
            </p>
            <ul className="grid gap-1 text-sm">
              {skill.variants.slice(0, 25).map((variant) => (
                <li key={variant.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {(variant.similarity * 100).toFixed(1)}%
                  </span>
                  <Link
                    href={`/skills/${variant.slug}`}
                    className="underline underline-offset-4"
                  >
                    {variant.name}
                  </Link>
                  <span className="text-muted-foreground text-xs">{variant.sourceName}</span>
                </li>
              ))}
            </ul>
            {skill.variants.length > 25 ? (
              <p className="text-muted-foreground text-xs">
                and {skill.variants.length - 25} more
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <ProvenanceCard
        sourceName={skill.sourceName}
        sourceUrl={skill.sourceUrl}
        provenance={skill.provenance}
        contentHash={skill.contentHash}
        licenseSpdx={skill.licenseSpdx}
        licenseSource={skill.licenseSource}
        licenseEvidence={skill.licenseEvidence}
        redistribution={skill.redistribution}
        syncedAt={skill.syncedAt}
      />
      {/*
        The citable permalink (R8.4).
        
        Offered here rather than only documented, because a verdict nobody can find a stable
        URL for is a verdict nobody cites. The hash is the address: it is what the verdicts
        cover, so a reader holding the archive can check the bytes match.
      */}
      <p className="text-muted-foreground text-sm">
        <Link
          href={`/skills/${skill.slug}/${skill.contentHash.slice(0, 12)}`}
          className="hover:text-foreground underline underline-offset-4"
        >
          Cite this exact version
        </Link>{" "}
        — a permalink to the bytes these verdicts judged, which does not change when the
        skill does.
      </p>

      {/*
        Last on the page, quietly. R2.5's route from a reader to the quarantine queue, and
        R7.5's public notice form — the piece CLAUDE.md flagged as the obvious next step when
        takedowns shipped admin-only.

        A prominent button here would fill a curator's queue with idle clicks; a reader who
        has actually found a credential in a skill will look for this.
      */}
      {/*
        Beside the report forms, at the foot of the page.

        Both are things a reader decides *after* reading — following it, or telling us something
        is wrong — and both are deliberately quiet. A prominent Watch button at the top would
        compete with the download, which is what most people came for.
      */}
      {session ? (
        <div className="flex items-center gap-3">
          <WatchButton skillId={skill.id} initiallyWatching={watching} />
          <span className="text-muted-foreground text-xs">
            New versions, quarantines and licence changes appear on your dashboard.
          </span>
        </div>
      ) : null}

      <ReportForms slug={skill.slug} canTakedown={skill.status !== "withdrawn"} />
    </div>
  );
}
