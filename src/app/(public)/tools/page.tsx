import type { Metadata } from "next";
import Link from "next/link";

import { TOOL_KIND_META, TOOL_KINDS, TOOLS } from "@/lib/tools";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toolDirectory } from "@/server/skills/tools-read";

export const metadata: Metadata = {
  title: "Tools",
  description:
    "Which commands the skills in this registry tell an agent to run, counted across the corpus.",
};

/**
 * The tool index (Doc 7 RD.6 / RD.7).
 *
 * Public, like the registry and the archetypes, and for the same reason: it is a decision
 * surface. *I have these tools installed — what can I actually run?* is the question a
 * consumer asks before anything else, and until now the platform could not answer it.
 *
 * ## Every tool is listed, including the ones nothing uses
 *
 * The vocabulary was written from a count over 50,965 documents, so a zero here is a real
 * finding about the corpus rather than a gap in the list — and hiding zeros would make the
 * page look finished while telling a reader nothing about where the registry is thin. Same
 * argument `/archetypes` makes for listing categories below the evidence gate.
 */
export default async function ToolsPage() {
  const { counts, coverage, available } = await toolDirectory();
  const byTool = new Map(counts.map((row) => [row.tool, row.skills]));

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Tools</h1>
        <p className="text-muted-foreground max-w-3xl">
          What the skills in this registry tell an agent to run — read from their command
          lines, their <code className="font-mono text-xs">allowed-tools</code> frontmatter,
          and mentions those two confirm. This is the other half of the capability surface:
          that one reads bundled code, and most skills in the corpus ship none.
        </p>
      </div>

      {/*
        Coverage above the table, always.

        A short list of counts over a corpus nothing has been resolved for reads as a quiet
        corpus, which is the `archetypes --blocks` misreading — and it is the reason that
        command now refuses to print a table without saying what it is a table of.
      */}
      <Coverage coverage={coverage} available={available} />

      {TOOL_KINDS.map((kind) => {
        const tools = TOOLS.filter((tool) => tool.kind === kind);
        if (tools.length === 0) return null;
        return (
          <section key={kind} className="grid gap-3">
            <div className="grid gap-1">
              <h2 className="text-base font-semibold">{TOOL_KIND_META[kind].label}</h2>
              <p className="text-muted-foreground text-sm">{TOOL_KIND_META[kind].blurb}</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tools
                .slice()
                .sort((a, b) => (byTool.get(b.id) ?? 0) - (byTool.get(a.id) ?? 0))
                .map((tool) => (
                  <li key={tool.id}>
                    <ToolTile
                      id={tool.id}
                      label={tool.label}
                      blurb={tool.blurb}
                      destructive={tool.destructive}
                      count={byTool.get(tool.id) ?? 0}
                      measured={available && (coverage?.resolved ?? 0) > 0}
                    />
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Coverage({
  coverage,
  available,
}: {
  coverage: Awaited<ReturnType<typeof toolDirectory>>["coverage"];
  available: boolean;
}) {
  if (!available || coverage === null) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-6 text-sm">
          Nothing has been resolved yet, so every count below is zero for that reason rather
          than because the corpus is quiet. The vocabulary on this page is real; the numbers
          arrive with <code className="font-mono text-xs">pnpm structures --resolve-tools</code>.
        </CardContent>
      </Card>
    );
  }

  const share =
    coverage.fingerprinted > 0
      ? Math.round((coverage.resolved / coverage.fingerprinted) * 100)
      : 0;

  return (
    <Card>
      <CardContent className="text-muted-foreground grid gap-1 py-6 text-sm">
        <p>
          <span className="text-foreground font-medium">
            {coverage.resolved.toLocaleString()} of {coverage.fingerprinted.toLocaleString()}
          </span>{" "}
          documents resolved ({share}%), of which{" "}
          {coverage.withRefs.toLocaleString()} named at least one candidate command.
        </p>
        <p>
          {/*
            The unrecognised share, printed rather than hidden. It is the honest measure of
            whether this vocabulary is complete enough to filter on — the same number the
            unclassified block share reports for the block taxonomy, and for the same reason.
            A vocabulary that named everything would be guessing.
          */}
          {coverage.namedTokens.toLocaleString()} of{" "}
          {coverage.distinctTokens.toLocaleString()} distinct tokens are named by the
          vocabulary below; the other {coverage.unrecognisedShare}% are the long tail — one-off
          scripts, product names and text the detector read as a command. They are counted, not
          discarded.
        </p>
      </CardContent>
    </Card>
  );
}

function ToolTile({
  id,
  label,
  blurb,
  destructive,
  count,
  measured,
}: {
  id: string;
  label: string;
  blurb: string;
  destructive: boolean;
  count: number;
  measured: boolean;
}) {
  return (
    <Link
      href={`/tools/${encodeURIComponent(id)}`}
      className="hover:border-primary/50 focus-visible:ring-ring block h-full rounded-xl outline-hidden focus-visible:ring-2"
    >
      <Card className="h-full transition-colors">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {label}
            {destructive ? (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-[11px] font-normal text-amber-600 dark:text-amber-400"
              >
                can destroy
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {/* Zero and unmeasured are different sentences, on every surface. */}
            {!measured
              ? "not measured yet"
              : count === 0
                ? "no skill in the registry names it"
                : `${count.toLocaleString()} skill${count === 1 ? "" : "s"}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground min-w-0 text-sm">{blurb}</CardContent>
      </Card>
    </Link>
  );
}
