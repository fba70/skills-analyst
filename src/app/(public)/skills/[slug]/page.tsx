import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { CapabilitySurface } from "@/components/registry/capability-surface";
import { ConsistencyCard } from "@/components/registry/consistency-card";
import { DownloadCard } from "@/components/registry/download-card";
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
import { withdrawalNotice } from "@/server/compliance/takedown";
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

  const mined = await minedCategories();
  const archetypeCategory = skill.categories.find(
    (category) => category.axis === "function" && mined.has(category.value),
  );

  const findings = skill.verdicts.flatMap((verdict) =>
    verdict.findings.map((finding) => ({ ...finding, analyzer: verdict.analyzer })),
  );

  return (
    <div className="grid min-w-0 max-w-4xl gap-6">
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
        {skill.summary ? <p className="text-muted-foreground">{skill.summary}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <OverallVerdict verdicts={skill.verdicts} status={skill.status} />
          <Badge variant="outline">Quality {skill.qualityScore ?? "—"}/100</Badge>
          <Badge variant="outline">{skill.dialect.replace(/_/g, " ")}</Badge>
          {skill.fileCount ? (
            <Badge variant="outline">
              {skill.fileCount} file{skill.fileCount === 1 ? "" : "s"}
            </Badge>
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

      <ConsistencyCard verdicts={skill.verdicts} />

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
          <CardTitle>Validation</CardTitle>
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
          <CardTitle>Capability surface</CardTitle>
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
    </div>
  );
}
