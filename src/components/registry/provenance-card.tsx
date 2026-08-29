import { GitCommitHorizontal } from "lucide-react";

import { LicenseBadge, licensePostureDetail } from "@/components/registry/license-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Where this came from, and what we are allowed to do with it (Doc 2 R1.3, R1.6, G5).
 *
 * The licence chain is shown, not just its conclusion. "Apache-2.0" is a claim;
 * "Apache-2.0, read from skills/canvas-design/LICENSE.txt" is evidence — and it is what
 * lets someone check our answer instead of trusting it.
 */

type ChainStep = { step: string; from: string; result: string };

export function ProvenanceCard({
  sourceName,
  sourceUrl,
  provenance,
  contentHash,
  licenseSpdx,
  licenseSource,
  licenseEvidence,
  redistribution,
  syncedAt,
}: {
  sourceName: string | null;
  sourceUrl: string | null;
  provenance: Record<string, unknown>;
  contentHash: string;
  licenseSpdx: string | null;
  licenseSource: string;
  licenseEvidence: Record<string, unknown> | null;
  redistribution: string;
  syncedAt: Date;
}) {
  const commitSha = typeof provenance.commitSha === "string" ? provenance.commitSha : null;
  const path = typeof provenance.path === "string" ? provenance.path : null;
  const chain = (licenseEvidence?.considered as ChainStep[] | undefined) ?? [];
  const resolvedFrom =
    typeof licenseEvidence?.from === "string" ? (licenseEvidence.from as string) : null;

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Source",
      value: sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4"
        >
          {sourceName ?? sourceUrl}
        </a>
      ) : (
        (sourceName ?? "—")
      ),
    },
    { label: "Path", value: path ? <code className="text-xs">{path}</code> : "—" },
    {
      label: "Commit",
      value: commitSha ? (
        <span className="inline-flex items-center gap-1.5">
          <GitCommitHorizontal className="text-muted-foreground size-3.5" />
          <code className="text-xs">{commitSha.slice(0, 12)}</code>
        </span>
      ) : (
        "—"
      ),
    },
    { label: "Content hash", value: <code className="text-xs">sha256:{contentHash.slice(0, 24)}…</code> },
    { label: "Last synced", value: syncedAt.toISOString().replace("T", " ").slice(0, 16) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provenance &amp; licence</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <LicenseBadge redistribution={redistribution} spdx={licenseSpdx} />
            <span className="text-muted-foreground text-xs">
              resolved by {licenseSource.replace(/_/g, " ")}
              {resolvedFrom ? ` · ${resolvedFrom}` : ""}
            </span>
          </div>
          <p className="text-muted-foreground text-sm">
            {licensePostureDetail(redistribution)}
          </p>
        </div>

        {chain.length > 0 ? (
          <div className="grid gap-1.5">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Licence chain
            </p>
            <ol className="grid gap-1 text-xs">
              {chain.map((step, index) => (
                <li key={`${step.step}-${index}`} className="flex gap-2">
                  <span className="text-muted-foreground w-32 shrink-0">
                    {step.step.replace(/_/g, " ")}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <code className="text-[11px]">{step.from}</code> — {step.result}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
