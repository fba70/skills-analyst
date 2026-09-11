import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { blockTypeBlurb, blockTypeLabel } from "@/lib/block-types";
import { capabilityBlurb, capabilityLabel } from "@/lib/capabilities";
import { TOOL_KIND_META, toolById } from "@/lib/tools";
import { Fragments } from "@/components/builder/block-library";
import { Paginator } from "@/components/common/paginator";
import { ExplainLink } from "@/components/registry/explain";
import { SkillRow } from "@/components/registry/skill-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listSkills, PAGE_SIZES, type PageSize } from "@/server/dal/skills";
import { toolDirectory, toolEvidence } from "@/server/skills/tools-read";

export async function generateMetadata(
  props: PageProps<"/tools/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const tool = toolById(decodeURIComponent(id));
  return {
    title: tool ? `${tool.label} — tools` : "Tool",
    description: tool?.blurb,
  };
}

/**
 * One tool: what it is, what using it implies, and which skills name it (Doc 7 RD.7).
 *
 * The list is `listSkills({ tools: [id] })` — the registry's own function and the registry's
 * own row — so this page cannot disagree with `/skills?tool=…` about what the filter means.
 * A second query shaped for this page is how two answers to one question start to drift, and
 * it is the rule RM.2 states for MCP and that applies to any second reader.
 */
export default async function ToolPage(props: PageProps<"/tools/[id]">) {
  const { id } = await props.params;
  const params = await props.searchParams;
  const toolId = decodeURIComponent(id);
  const tool = toolById(toolId);

  /*
   * An unknown id is a 404 rather than an empty list. The vocabulary is closed, so a slug
   * that is not in it is a wrong URL, and rendering "0 skills" for one would claim the
   * registry had looked and found nothing.
   */
  if (!tool) notFound();

  const single = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const requestedSize = Number(single("size"));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(requestedSize)
    ? (requestedSize as PageSize)
    : undefined;

  const [result, directory, evidence] = await Promise.all([
    listSkills({ tools: [toolId], page: Number(single("page")) || 1, pageSize }),
    toolDirectory(),
    toolEvidence(toolId, tool.destructive),
  ]);

  const measured = directory.available && (directory.coverage?.resolved ?? 0) > 0;
  const first = (result.page - 1) * result.pageSize + 1;
  const last = Math.min(result.page * result.pageSize, result.total);

  return (
    <div className="grid min-w-0 gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/tools">
            <ArrowLeft className="size-4" />
            Tools
          </Link>
        </Button>
      </div>

      <header className="grid gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{tool.label}</h1>
        <p className="text-muted-foreground max-w-3xl">{tool.blurb}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{TOOL_KIND_META[tool.kind].label}</Badge>
          {tool.destructive ? (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            >
              can change state irreversibly
            </Badge>
          ) : null}
          {tool.aliases?.length ? (
            <Badge variant="outline" className="text-muted-foreground font-normal">
              also {tool.aliases.join(", ")}
            </Badge>
          ) : null}
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-baseline gap-3">
            What using it implies
            <ExplainLink anchor="capabilities">What are capabilities?</ExplainLink>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {tool.capabilities.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing on the R2.4 surface: it reaches no files, no network and no credentials.
            </p>
          ) : (
            <ul className="grid gap-2">
              {tool.capabilities.map((capability) => (
                <li key={capability} className="grid gap-0.5">
                  <span className="text-sm font-medium">{capabilityLabel(capability)}</span>
                  <span className="text-muted-foreground text-sm">
                    {capabilityBlurb(capability)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/*
            Stated rather than left to be inferred. These are the capabilities *using the
            tool* implies, which is a property of the tool; the capability surface on a skill
            page is measured from that skill's own bundled code. A reader who conflates them
            would think we had scanned something.
          */}
          <p className="text-muted-foreground border-t pt-3 text-sm">
            A property of the tool, not a measurement of any skill. A skill&rsquo;s own
            capability surface is scanned from the code it ships.
          </p>
        </CardContent>
      </Card>

      {measured ? (
        <Card>
          <CardHeader>
            <CardTitle>What good skills say about it</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            {evidence.groups.length === 0 ? (
              /*
                Distinct from "nothing uses it", which the skill list below answers on its own
                evidence. A tool can be widely used and still have nothing quotable: every
                passage about it may sit outside the word bounds, come from one repository, or
                belong to a skill whose licence forbids copying. Saying "no examples" for both
                would let a reader conclude the corpus is silent when it is only unquotable.
              */
              <p className="text-muted-foreground text-sm">
                Nothing quotable was found for {tool.label}. Passages about it may be too short
                or too long to be exemplary, may all come from one repository, or may belong to
                skills whose licence does not permit copying — which is a gap in what can be
                shown, not evidence that nobody writes about it.
              </p>
            ) : (
              evidence.groups.map((group) => (
                <div key={group.type} className="grid gap-2">
                  <div className="grid gap-0.5">
                    <h3 className="text-sm font-medium">{blockTypeLabel(group.type)}</h3>
                    <p className="text-muted-foreground text-xs">
                      {blockTypeBlurb(group.type)}
                    </p>
                  </div>
                  <Fragments result={group.result} />
                </div>
              ))
            )}
            {/*
              The same refusal the library makes everywhere, stated where the passages are.
              Most of this corpus is attribution-required, and a control that pasted one of
              these into a draft would launder that obligation into a document carrying none.
            */}
            <p className="text-muted-foreground border-t pt-3 text-xs">
              Examples to read, from the curated band the archetypes are mined from. Each is
              somebody else&rsquo;s work and stays theirs.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-3">
        <h2 className="text-base font-semibold">
          {!measured
            ? "Skills naming it"
            : `${result.total.toLocaleString()} skill${result.total === 1 ? "" : "s"} name it`}
        </h2>

        {!measured ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              Not measured yet — no document has been resolved, so this list is empty for that
              reason rather than because nothing uses {tool.label}. Run{" "}
              <code className="font-mono text-xs">pnpm structures --resolve-tools</code>.
            </CardContent>
          </Card>
        ) : result.total === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              No skill in the registry names {tool.label}. That is a fact about the corpus:
              the vocabulary entry exists because the extractor counted the token somewhere,
              but no served version currently carries it.
            </CardContent>
          </Card>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Showing {first}–{last} of {result.total}
            </p>
            <ul className="grid gap-3">
              {result.items.map((skill) => (
                <li key={skill.id}>
                  <SkillRow skill={skill} />
                </li>
              ))}
            </ul>
            <Paginator
              page={result.page}
              pageCount={result.pageCount}
              basePath={`/tools/${encodeURIComponent(toolId)}`}
              searchParams={params}
            />
          </>
        )}
      </section>
    </div>
  );
}
