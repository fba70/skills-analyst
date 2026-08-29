import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { CapabilitySurface } from "@/components/registry/capability-surface";
import { ProvenanceCard } from "@/components/registry/provenance-card";
import {
  OverallVerdict,
  VerdictBadge,
  type VerdictResult,
} from "@/components/registry/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSkillBySlug } from "@/server/dal/skills";
import { requireSession } from "@/server/dal/session";

export async function generateMetadata(
  props: PageProps<"/skills/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const skill = await getSkillBySlug(slug);
  return { title: skill?.name ?? "Skill" };
}

export default async function SkillPage(props: PageProps<"/skills/[slug]">) {
  await requireSession();
  const { slug } = await props.params;
  const skill = await getSkillBySlug(slug);
  if (!skill) notFound();

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
      </header>

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
