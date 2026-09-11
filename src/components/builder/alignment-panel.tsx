import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BlockType } from "@/lib/block-types";
import { capabilityLabel } from "@/lib/capabilities";
import {
  ALIGNMENT_META,
  type AlignmentFinding,
  type AlignmentReport,
} from "@/lib/alignment";

/**
 * What this draft runs, and whether its three answers agree (Doc 7 RD.8).
 *
 * A skill says what it reaches for in three places — the steps, `allowed-tools`, and the code
 * it ships — and until now nothing compared them. A step that runs `kubectl` under an
 * `allowed-tools` that never granted it is a call the harness refuses at the moment it is
 * needed, and the author is the last person to find out.
 *
 * ## Nothing here blocks a publish, and the copy has to say so
 *
 * A deployment skill runs `kubectl delete`; that is its job. R4.5's analyzers decide whether a
 * draft may ship and they are not consulted here, so every row states a fact and offers the
 * smallest thing that would fix it. The loudest finding this panel can produce still publishes
 * — `verify:tool-alignment` asserts exactly that.
 *
 * ## Three empty states, because they are three different facts
 *
 * *Nothing to compare* is not *compared, and it agrees*, and a green tick over the first is the
 * failure this codebase keeps paying for. A draft that names no tools and ships no files has
 * not passed anything. Separately, a draft with no `allowed-tools` of its own is not in
 * disagreement with anything — it simply has not written one yet, and the export will.
 *
 * ## `onAdd` inserts an empty block, and never a fragment
 *
 * The same refusal `DeviationCard` makes, and the same callback: an empty typed block at the
 * end of the draft for the author to write into. Pasting an exemplar would launder an
 * attribution-required fragment into a document carrying none, which is why the block library
 * has no copy button either.
 */
export function AlignmentPanel({
  report,
  onAdd,
}: {
  report: AlignmentReport;
  /** Omitted on a read-only surface; the buttons then do not render at all. */
  onAdd?: (type: BlockType) => void;
}) {
  /*
   * Nothing to compare. Deliberately not a tick and deliberately not silent: an absent panel
   * would read as "no problems", which is the same wrong conclusion one step quieter.
   */
  if (!report.measured) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Tools this draft runs</CardTitle>
          <CardDescription>
            This draft names no tools and ships no files, so there was nothing to compare. That
            is the absence of a measurement rather than a clean result.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const act = report.findings.filter((f) => ALIGNMENT_META[f.kind].severity === "act");
  const consider = report.findings.filter((f) => ALIGNMENT_META[f.kind].severity === "consider");
  const generates = report.findings.some((f) => f.fix === "generate-allowed-tools");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          Tools this draft runs
          <span className="text-muted-foreground text-xs font-normal">
            {report.prose.length} named in the steps
            {report.declared ? ` · ${report.declared.length} granted` : null}
          </span>
        </CardTitle>
        <CardDescription>
          The steps, the <code className="text-xs">allowed-tools</code> grant and the bundled
          files should describe one skill. Where they differ it is worth a look, not a
          correction — publishing is gated on the analyzers and on nothing here.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {report.findings.length === 0 ? (
          <p className="text-sm">
            The steps, <code className="text-xs">allowed-tools</code> and the bundled files
            agree.
          </p>
        ) : null}

        {act.length > 0 ? (
          <FindingGroup
            heading="Worth acting on"
            findings={act}
            onAdd={onAdd}
          />
        ) : null}

        {consider.length > 0 ? (
          <FindingGroup
            heading="Worth considering"
            findings={consider}
            onAdd={onAdd}
            bordered={act.length > 0}
          />
        ) : null}

        {/*
          One block, once, rather than beside every ungranted tool. An author with six
          undeclared tools has one list to look at, and six copies of it would read as six
          separate things to do.
        */}
        {(generates || report.declared === null) && report.proposedAllowedTools ? (
          <section className="grid gap-2 border-t pt-4">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              What the SKILL.md export will declare
            </h3>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
              <code>allowed-tools: {report.proposedAllowedTools}</code>
            </pre>
            <p className="text-muted-foreground text-xs">
              Derived from the steps and written into the SKILL.md export only. There is no
              button here that changes your draft: `allowed-tools` is Claude Code&rsquo;s key,
              and the canonical draft stays dialect-neutral so the AGENTS.md and Cursor exports
              are unaffected.
            </p>
          </section>
        ) : null}

        {/*
          Not a disagreement, so not a finding — but the author should know the export fills
          this in rather than shipping a skill that grants nothing.
        */}
        {report.declared === null ? (
          <p className="text-muted-foreground border-t pt-4 text-xs">
            This draft declares no <code className="text-xs">allowed-tools</code> of its own, so
            there is nothing to disagree with yet.
            {report.proposedAllowedTools
              ? " The export generates the list above from the steps."
              : " Name a tool in a step and the export will generate one."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FindingGroup({
  heading,
  findings,
  onAdd,
  bordered,
}: {
  heading: string;
  findings: AlignmentFinding[];
  onAdd?: (type: BlockType) => void;
  bordered?: boolean;
}) {
  return (
    <section className={bordered ? "grid gap-2 border-t pt-4" : "grid gap-2"}>
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {heading}
      </h3>
      <ul className="grid gap-3">
        {findings.map((finding, index) => (
          <li key={`${finding.kind}-${finding.tool ?? finding.capability ?? index}`} className="grid gap-0.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <Badge variant="outline" className="text-[11px]">
                {ALIGNMENT_META[finding.kind].label}
              </Badge>
              {finding.capability ? (
                <span className="text-muted-foreground text-xs">
                  {capabilityLabel(finding.capability)}
                </span>
              ) : null}
            </div>
            {/* The sentence is written in the leaf module, so the panel renders it rather
                than composing a second phrasing of the same fact. */}
            <p className="text-sm">
              <Ticked text={finding.message} />
            </p>
            <p className="text-muted-foreground text-xs">
              {ALIGNMENT_META[finding.kind].blurb}
            </p>
            <Fix finding={finding} onAdd={onAdd} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fix({
  finding,
  onAdd,
}: {
  finding: AlignmentFinding;
  onAdd?: (type: BlockType) => void;
}) {
  if (!onAdd) return null;

  const type: BlockType | null =
    finding.fix === "add-tool-contract"
      ? "tool-contract"
      : finding.fix === "add-guardrail"
        ? "guardrail"
        : null;

  // `generate-allowed-tools` is answered once, below the list; `none` offers nothing at all,
  // because a broad grant may be exactly what the author meant.
  if (!type) return null;

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-1 h-7 text-xs"
        onClick={() => onAdd(type)}
      >
        Add {type === "guardrail" ? "a guardrail" : "a tool contract"} here
      </Button>
    </div>
  );
}

/**
 * Renders the backtick spans in a written sentence as code, and nothing else.
 *
 * Not a markdown renderer: the messages come from one leaf module and use exactly one mark,
 * so anything more would be a parser with no second input to justify it — and would risk
 * interpreting a tool name as formatting.
 */
function Ticked({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="text-xs">
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}
