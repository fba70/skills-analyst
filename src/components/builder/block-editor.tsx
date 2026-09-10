"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  Heading,
  Loader2,
  Merge,
  Plus,
  Save,
  Scissors,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { saveDraftBlocksAction } from "@/app/(protected)/build/actions";
import { DeviationCard } from "@/components/builder/deviation-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { BlockType } from "@/lib/block-types";
import {
  DRAFT_BLOCK_TYPE_OPTIONS,
  MAX_HEADING_DEPTH,
  MIN_HEADING_DEPTH,
  renderDraftBody,
  type DraftBlock,
} from "@/lib/draft-blocks";
import type { DeviationReport } from "@/server/builder/deviation";

/**
 * Editing a draft as blocks (plan steps C1 and C1b).
 *
 * ## Why this replaced a `<pre>`
 *
 * The draft page used to render the generated body as source in a scroll box, which is an
 * honest way to show a string and no way at all to change one. Every step queued behind M1
 * needs the author to act on *parts* of the document — accept one candidate block from an
 * interview turn, retype a passage the extractor guessed wrong, move a guardrail out of a
 * procedure — and none of those is expressible over a textarea holding 8,000 characters.
 *
 * ## The whole list is the unit of change
 *
 * Every gesture here is local, and one Save writes the list. That is not laziness about
 * autosave: `block_order` is contiguous and unique per draft, so an operation-per-gesture
 * design has six different renumberings to get right against the same index, and each save
 * re-renders and re-validates the document anyway. One write, one validation, one thing to
 * reason about.
 *
 * It also means **the page's numbers describe the saved draft, never the unsaved one.** The
 * validation panel and the archetype comparison beside this editor are computed on the
 * server from the stored blocks. Recomputing them live would need the analyzers in the
 * browser, and showing a stale panel next to edited text with no marker would be worse than
 * either — so unsaved changes are stated, in words, above the Save button.
 *
 * ## Nothing here is destructive without the author saying so twice
 *
 * Delete removes a block from the local list; the row is only gone once they save. There is
 * no undo stack, and that is a real gap rather than a decision — it is cheap to add over an
 * array of blocks and expensive over a string, which is one more argument for the model.
 */

type EditorBlock = DraftBlock & { key: string };

let keySeed = 0;
function nextKey(): string {
  keySeed += 1;
  return `new-${keySeed}`;
}

function toEditor(blocks: DraftBlock[]): EditorBlock[] {
  return blocks.map((block) => ({ ...block, key: block.id }));
}

export function BlockEditor({
  draftId,
  blocks: initial,
  deviations,
  disabled,
}: {
  draftId: string;
  blocks: DraftBlock[];
  deviations: DeviationReport | null;
  /** True while a generation is in flight — the body is about to be replaced wholesale. */
  disabled: boolean;
}) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => toEditor(initial));
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  /*
   * Where the caret is, per block, so Split can cut where the author is looking.
   *
   * A ref rather than state: it changes on every keystroke and arrow key, and re-rendering
   * a list of textareas for a cursor move would make typing visibly worse for a feature
   * that is read exactly once, when the Split button is pressed.
   */
  const carets = useRef<Map<string, number>>(new Map());

  const mutate = useCallback((next: (current: EditorBlock[]) => EditorBlock[]) => {
    setBlocks((current) => next(current).map((block, order) => ({ ...block, order })));
    setDirty(true);
  }, []);

  const preview = useMemo(() => renderDraftBody(blocks), [blocks]);

  function save() {
    startTransition(async () => {
      const result = await saveDraftBlocksAction(
        draftId,
        blocks.map((block) => ({
          /*
           * A block that already exists keeps its id, so a decision attached to it later —
           * C2b's accept/reject, D1's eval case — survives a reorder. A block created in
           * this session has none and the database assigns one.
           */
          id: block.id.startsWith("new-") ? undefined : block.id,
          form: block.form,
          depth: block.depth,
          type: block.type,
          text: block.text,
          /*
           * The structure behind a decision rule travels with the save (Doc 7 RD.2). The
           * editor never edits it; it carries it, so an author fixing a typo two blocks away
           * does not silently lose a table's rows. If they edited the rendered text itself, the
           * hash stops matching and the panel says the structure is out of date.
           */
          rule: block.rule ?? null,
        })),
      );
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setBlocks(toEditor(result.data.blocks));
      setDirty(false);
      toast.success(
        result.data.validation.findings.length === 0
          ? "Saved. No findings."
          : `Saved. ${result.data.validation.findings.length} finding${
              result.data.validation.findings.length === 1 ? "" : "s"
            } — see below.`,
      );
      router.refresh();
    });
  }

  function insertAt(index: number, block: Omit<EditorBlock, "order" | "key" | "id">) {
    const key = nextKey();
    mutate((current) => [
      ...current.slice(0, index),
      { ...block, id: key, key, order: index },
      ...current.slice(index),
    ]);
  }

  const addTyped = useCallback(
    (type: BlockType) => {
      const key = nextKey();
      mutate((current) => [
        ...current,
        { id: key, key, order: current.length, form: "content", depth: null, type, text: "" },
      ]);
      toast.info("An empty block was added at the end. Write what belongs in it.");
    },
    [mutate],
  );

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= blocks.length) return;
    mutate((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  /**
   * Split at the caret.
   *
   * The author decides where the boundary is, because only they know: a rule could split on
   * a blank line, but a blank line is already a block boundary — the extractor put it there
   * — so the splits that need doing are exactly the ones no rule found. Both halves keep the
   * original type, which is right more often than clearing it and is one click to change.
   */
  function split(index: number) {
    const block = blocks[index];
    if (block.form !== "content") return;
    const at = carets.current.get(block.key) ?? 0;
    const head = block.text.slice(0, at).replace(/\s+$/, "");
    const tail = block.text.slice(at).replace(/^\s+/, "");
    if (!head || !tail) {
      toast.error("Put the cursor where the block should be cut.");
      return;
    }
    const key = nextKey();
    mutate((current) => [
      ...current.slice(0, index),
      { ...block, text: head },
      { ...block, id: key, key, text: tail },
      ...current.slice(index + 1),
    ]);
  }

  /** Merge into the block above. Only ever content into content — a heading is a label. */
  function mergeUp(index: number) {
    if (index === 0) return;
    const above = blocks[index - 1];
    const block = blocks[index];
    if (above.form !== "content" || block.form !== "content") {
      toast.error("A heading cannot be merged. Delete it, or move the block past it.");
      return;
    }
    mutate((current) => [
      ...current.slice(0, index - 1),
      { ...above, text: `${above.text}\n\n${block.text}` },
      ...current.slice(index + 1),
    ]);
  }

  function remove(index: number) {
    mutate((current) => current.filter((_, i) => i !== index));
  }

  function update(index: number, patch: Partial<EditorBlock>) {
    mutate((current) => current.map((block, i) => (i === index ? { ...block, ...patch } : block)));
  }

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
            Blocks
            <span className="text-muted-foreground text-xs font-normal">
              {blocks.length} in this draft · {preview.length.toLocaleString()} characters
            </span>
          </CardTitle>
          <CardDescription>
            The document is these blocks, in this order. SKILL.md is rendered from them when
            you save, and published and exported from that render — so what you edit here is
            what ships.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-3">
          {blocks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing yet. Add a heading or a passage below, or generate a first draft.
            </p>
          ) : null}

          {blocks.map((block, index) => (
            <div key={block.key} className="grid min-w-0 gap-2 rounded-md border p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                  {index + 1}
                </span>

                {block.form === "heading" ? (
                  <>
                    <Badge variant="secondary" className="shrink-0">
                      Heading
                    </Badge>
                    <select
                      aria-label="Heading level"
                      className="border-input bg-background h-8 shrink-0 rounded-md border px-2 text-xs"
                      value={block.depth ?? 2}
                      disabled={disabled}
                      onChange={(e) => update(index, { depth: Number(e.target.value) })}
                    >
                      {Array.from(
                        { length: MAX_HEADING_DEPTH - MIN_HEADING_DEPTH + 1 },
                        (_, i) => i + MIN_HEADING_DEPTH,
                      ).map((depth) => (
                        <option key={depth} value={depth}>
                          H{depth}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <select
                    aria-label="Block type"
                    className="border-input bg-background h-8 min-w-0 rounded-md border px-2 text-xs"
                    value={block.type ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      update(index, { type: (e.target.value || null) as BlockType | null })
                    }
                  >
                    {DRAFT_BLOCK_TYPE_OPTIONS.map((option) => (
                      <option key={option.value ?? "none"} value={option.value ?? ""}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}

                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <IconButton
                    label="Move up"
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    disabled={disabled || index === blocks.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  {block.form === "content" ? (
                    <>
                      <IconButton
                        label="Split at the cursor"
                        disabled={disabled}
                        onClick={() => split(index)}
                      >
                        <Scissors className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Merge into the block above"
                        disabled={disabled || index === 0}
                        onClick={() => mergeUp(index)}
                      >
                        <Merge className="size-3.5" />
                      </IconButton>
                    </>
                  ) : null}
                  <IconButton
                    label="Delete this block"
                    disabled={disabled}
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="text-destructive size-3.5" />
                  </IconButton>
                </div>
              </div>

              {block.form === "heading" ? (
                <Input
                  value={block.text}
                  disabled={disabled}
                  aria-label={`Heading ${index + 1}`}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
              ) : (
                <textarea
                  className="border-input bg-background focus-visible:ring-ring/50 min-h-24 w-full min-w-0 resize-y rounded-md border p-2 font-mono text-xs leading-relaxed focus-visible:ring-[3px] focus-visible:outline-none"
                  value={block.text}
                  disabled={disabled}
                  aria-label={`Block ${index + 1}`}
                  rows={Math.min(20, Math.max(3, block.text.split("\n").length + 1))}
                  onChange={(e) => {
                    carets.current.set(block.key, e.target.selectionStart ?? 0);
                    update(index, { text: e.target.value });
                  }}
                  onSelect={(e) => {
                    carets.current.set(block.key, e.currentTarget.selectionStart ?? 0);
                  }}
                />
              )}

              <InsertRow disabled={disabled} onInsert={(form) => insertAt(index + 1, blank(form))} />
            </div>
          ))}

          {blocks.length === 0 ? (
            <InsertRow disabled={disabled} onInsert={(form) => insertAt(0, blank(form))} />
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={disabled || isPending || !dirty}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save blocks
        </Button>
        <p className="text-muted-foreground text-sm">
          {dirty
            ? "Unsaved changes. The validation and archetype panels below describe the last saved version."
            : "Saved. The panels below describe this document."}
        </p>
      </div>

      {/*
        Inside the editor, not beside it, so the missing-block list can put a block into the
        draft. Rendering it on the page as a sibling would mean the panel and the list it
        wants to append to live in two React trees with nothing between them.
      */}
      {deviations ? <DeviationCard report={deviations} onAdd={addTyped} /> : null}
    </div>
  );
}

function blank(form: "heading" | "content"): Omit<EditorBlock, "order" | "key" | "id"> {
  return form === "heading"
    ? { form: "heading", depth: 2, type: null, text: "" }
    : { form: "content", depth: null, type: null, text: "" };
}

function InsertRow({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  onInsert: (form: "heading" | "content") => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 text-xs"
        disabled={disabled}
        onClick={() => onInsert("content")}
      >
        <Plus className="size-3.5" />
        Passage
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 text-xs"
        disabled={disabled}
        onClick={() => onInsert("heading")}
      >
        <Heading className="size-3.5" />
        Heading
      </Button>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
