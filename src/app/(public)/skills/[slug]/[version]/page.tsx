import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Explain } from "@/components/registry/explain";
import { OverallVerdict, VerdictBadge, type VerdictResult } from "@/components/registry/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSkillVersionByHash } from "@/server/dal/skills";

/**
 * A citable verdict (Doc 2 R8.4).
 *
 * ## Why a per-version page had to exist
 *
 * Everything else in the registry describes a skill *as it is now*. A verdict is about
 * specific bytes, and the skill page silently replaces those bytes every time upstream
 * changes — so anyone citing "this skill passed the injection scan" was citing something
 * that could quietly stop being true, with no way for a reader to tell. R8.4's other half is
 * archetype exemplars, whose whole value is staying resolvable after the upstream repository
 * moves.
 *
 * ## Addressed by content hash, so a citation is checkable
 *
 * `/skills/<slug>/<hash>`. The hash is what the verdicts cover and what the storage key is,
 * so a reader holding the downloaded archive can confirm the bytes they have are the bytes
 * that were judged. Twelve characters or more is accepted, resolved within that skill's own
 * versions — the page always states the hash in full, so nobody has to trust a prefix.
 *
 * ## It answers for versions that are no longer served
 *
 * That is the point rather than an oversight. A superseded, tombstoned or withdrawn version
 * resolves here and says what it is. What it never does is hand over content: this page shows
 * the *record*, and whether bytes may be served stays the download route's decision — one
 * definition of "servable", as R2.6 and R7.5 both require.
 */
export async function generateMetadata(
  props: PageProps<"/skills/[slug]/[version]">,
): Promise<Metadata> {
  const { slug, version } = await props.params;
  const cited = await getSkillVersionByHash(slug, version);
  return {
    title: cited ? `${cited.name} @ ${cited.contentHash.slice(0, 12)}` : "Skill version",
    /* Not indexable: a permalink is for citation, not for competing with the skill page in
       search results. */
    robots: { index: false, follow: true },
  };
}

export default async function SkillVersionPage(props: PageProps<"/skills/[slug]/[version]">) {
  const { slug, version } = await props.params;
  const cited = await getSkillVersionByHash(slug, version);
  if (!cited) notFound();

  const findings = cited.verdicts.flatMap((verdict) =>
    verdict.findings.map((finding) => ({ ...finding, analyzer: verdict.analyzer })),
  );

  return (
    <div className="grid min-w-0 gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/skills/${cited.slug}`}>
            <ArrowLeft className="size-4" />
            {cited.name}
          </Link>
        </Button>
      </div>

      <header className="grid gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{cited.name}</h1>
          <p className="text-muted-foreground font-mono text-xs break-all">
            {cited.contentHash}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Explain anchor="validation">
            <OverallVerdict verdicts={cited.verdicts} status={cited.status} />
          </Explain>
          {/*
            Whether this is the version being served is the first thing a reader of a citation
            needs, and the only thing the hash alone cannot tell them.
          */}
          <Badge variant={cited.current ? "secondary" : "outline"}>
            {cited.current ? "currently served" : `superseded · ${cited.status}`}
          </Badge>
          {cited.licenseSpdx ? <Badge variant="outline">{cited.licenseSpdx}</Badge> : null}
        </div>

        <p className="text-muted-foreground max-w-3xl text-sm">
          This page records one exact version. It does not change when the skill does, which is
          what makes a verdict citable — and it is not the download: whether these bytes may be
          served is decided by the licence, not by this page.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What was judged</CardTitle>
          <CardDescription>
            Both hashes are recomputable from a downloaded archive — the content hash over the
            bundle, the report hash over the verdicts below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <Row label="Content hash" value={cited.contentHash} mono />
          <Row label="Validation report hash" value={cited.reportHash} mono />
          {cited.commitSha ? <Row label="Commit" value={cited.commitSha} mono /> : null}
          {cited.upstreamPath ? <Row label="Upstream path" value={cited.upstreamPath} mono /> : null}
          {cited.sourceName ? (
            <Row
              label="Source"
              value={cited.sourceName}
              href={cited.sourceUrl ?? undefined}
            />
          ) : null}
          <Row label="Synced" value={cited.syncedAt.toISOString()} />
          {cited.fileCount !== null ? (
            <Row label="Files" value={String(cited.fileCount)} />
          ) : null}
          <Row label="Redistribution" value={cited.redistribution.replace(/_/g, " ")} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-baseline gap-3 text-base">
            Verdicts
            <span className="text-muted-foreground text-xs font-normal">
              newest per analyzer, with the version that produced it
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {cited.verdicts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No verdicts recorded for this version. That means it was never judged, not that
              it passed.
            </p>
          ) : (
            cited.verdicts.map((verdict) => (
              <div key={verdict.analyzer} className="flex flex-wrap items-baseline gap-2 text-sm">
                <VerdictBadge result={verdict.result as VerdictResult} />
                <span className="font-medium">{verdict.analyzer}</span>
                {/*
                  The analyzer version is the reproducibility half (R7.2): a verdict without
                  it cannot be re-derived, so a citation without it is not evidence.
                */}
                <span className="text-muted-foreground font-mono text-xs">
                  {verdict.analyzerVersion}
                </span>
                {verdict.findings.length > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {verdict.findings.length} finding
                    {verdict.findings.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {findings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Findings</CardTitle>
            <CardDescription>
              The evidence behind the verdicts, as recorded at the time.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {findings.map((finding, index) => (
              <div key={`${finding.reason}-${index}`} className="grid gap-0.5 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge variant="outline" className="text-[11px]">
                    {finding.severity}
                  </Badge>
                  <span className="font-mono text-xs">{finding.reason}</span>
                  <span className="text-muted-foreground text-xs">{finding.analyzer}</span>
                </div>
                {/* Analyzer output about untrusted content: text, never markup. */}
                <p className="text-muted-foreground">{finding.message}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[12rem_1fr] sm:gap-3">
      <span className="text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          className={`min-w-0 break-all underline underline-offset-4 ${mono ? "font-mono text-xs" : ""}`}
        >
          {value}
        </a>
      ) : (
        <span className={`min-w-0 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
      )}
    </div>
  );
}
