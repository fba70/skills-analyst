/**
 * The formats a draft can be written out as, in words a person picks from.
 *
 * A leaf module with no imports, for the same reason as `capabilities.ts` and
 * `section-roles.ts`: the export checkboxes are a client component and the renderer is
 * `server-only`, so the *list* has to live somewhere both can reach. Duplicating it would
 * put a fifth definition of the dialect vocabulary in the codebase and guarantee the
 * picker and the renderer eventually disagree about what a Cursor rule is called.
 *
 * The rendering itself stays on the server, where it belongs — it writes `Buffer`s.
 */

export type DialectId = "anthropic_skill" | "agents_md" | "cursor_rule";

export const EXPORT_DIALECTS: ReadonlyArray<{
  id: DialectId;
  label: string;
  /** Where the file lands in a consumer's project, shown next to the download. */
  hint: string;
}> = [
  { id: "anthropic_skill", label: "SKILL.md", hint: "drops into .claude/skills/<name>/" },
  { id: "agents_md", label: "AGENTS.md", hint: "repository root" },
  { id: "cursor_rule", label: "Cursor rule", hint: ".cursor/rules/<name>.mdc" },
];
