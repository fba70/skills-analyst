import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { TOOL_EVIDENCE_META, toolById, toolLabel, type ToolEvidence } from "@/lib/tools";
import { Badge } from "@/components/ui/badge";

/**
 * What this skill tells an agent to run (Doc 7 RD.7).
 *
 * The capability surface beside it reads the skill's **bundled code**; this reads its
 * **prose**, which is where most skills actually say what to do — 93% of the corpus is a lone
 * SKILL.md with no code at all, so for most skills this is the only thing that can answer the
 * question. Presented the same way, as description rather than accusation: a deployment skill
 * that runs `kubectl delete` is doing its job, and the reader is being told so they can decide.
 *
 * A `FREE_FOREVER` surface, so it renders for an anonymous reader exactly as for anybody else.
 */

export type ToolChipsProps = {
  tools: Array<{ tool: string; evidence: ToolEvidence }>;
  /**
   * Whether this version has been through `--resolve-tools` at all.
   *
   * The distinction this component exists to keep. *This skill names no tools* is a fact about
   * the skill and useful; *nothing has been resolved yet* is a fact about us, and rendering the
   * second as the first is the `archetypes --blocks` misreading — eleven rows of zeros at 1%
   * coverage, which read as a finding. An empty list therefore has two different sentences and
   * the caller has to say which it is.
   */
  resolved: boolean;
};

export function ToolChips({ tools, resolved }: ToolChipsProps) {
  if (!resolved) {
    return (
      <p className="text-muted-foreground text-sm">
        Not measured yet for this version. Tool references are derived from the extractor&rsquo;s
        stored token counts, and resolution has not run over this document.
      </p>
    );
  }

  if (tools.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This skill names no recognised tools — no commands in its steps and no{" "}
        <code className="font-mono text-xs">allowed-tools</code> in its frontmatter.
      </p>
    );
  }

  const destructive = tools.filter(({ tool }) => toolById(tool)?.destructive);

  return (
    <div className="grid gap-3">
      <ul className="flex flex-wrap gap-2">
        {tools.map(({ tool, evidence }) => {
          const meta = toolById(tool);
          const evidenceMeta = TOOL_EVIDENCE_META[evidence];
          return (
            <li key={tool}>
              {/*
                Linked to the tool page, which is the useful next question — *what else uses
                this* — rather than a definition. The category badges on this page take the
                same view. Safe to wrap individually: nothing on a detail page wraps these in
                an outer anchor, which is why the registry list gets one plain link instead.
              */}
              <Link
                href={`/tools/${encodeURIComponent(tool)}`}
                className="focus-visible:ring-ring rounded-md outline-hidden focus-visible:ring-2"
              >
                <Badge
                  variant="outline"
                  className="hover:border-primary/50 gap-1.5 font-normal transition-colors"
                  title={`${meta?.blurb ?? toolLabel(tool)} — ${evidenceMeta.label.toLowerCase()}: ${evidenceMeta.blurb}`}
                >
                  <span className="font-medium">{toolLabel(tool)}</span>
                  <span className="text-muted-foreground text-[11px]">
                    {evidenceMeta.label.toLowerCase()}
                  </span>
                </Badge>
              </Link>
            </li>
          );
        })}
      </ul>

      {destructive.length > 0 ? (
        /*
          Named, not scored, and never a refusal. `destructive` is deliberately narrow in
          `lib/tools.ts` — a flag true of everything is an alarm nobody can silence — so this
          line stays rare enough to be worth reading. It is the reader-facing half of what RD.8
          will tell an author about their own draft.
        */
        <p className="text-muted-foreground flex items-start gap-2 text-sm">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span>
            {destructive.map(({ tool }) => toolLabel(tool)).join(", ")}{" "}
            {destructive.length === 1 ? "can" : "can each"} change state that is not easily
            undone. Read the steps before running this unattended.
          </span>
        </p>
      ) : null}
    </div>
  );
}
