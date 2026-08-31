import "server-only";

import type { BundleFile } from "@/server/storage";
import type { DialectId } from "@/lib/dialects";

export type { DialectId };

/**
 * Rendering one draft into the format a given tool expects (Doc 2 R4.4).
 *
 * The draft holds a body and an identity; a *dialect* is how those get written to disk for
 * a particular consumer. Keeping the conversion here — pure, no database, no storage —
 * means the same function serves publishing (which writes one dialect into the corpus) and
 * export (which can write several into one archive), and neither can drift from the other.
 *
 * ## The differences are small and load-bearing
 *
 * These are not cosmetic. A Cursor rule with SKILL.md frontmatter is inert; an AGENTS.md
 * with any frontmatter at all is out of spec, because the format has none by definition —
 * which is the same fact that once caused all 121 AGENTS.md files in the corpus to be
 * quarantined against the wrong contract.
 *
 * ## What is deliberately not attempted
 *
 * No rewriting of the body per dialect. The prose is the author's and is already grounded
 * in their inputs; a model pass to "adapt tone for Cursor" would be an uninstructed edit of
 * their words, and would make two exports of the same draft differ. Only the envelope
 * changes.
 */

export type DraftSource = {
  name: string;
  slug: string;
  description: string;
  body: string;
};

/** The single file a dialect renders to, with the path a consumer expects. */
export function renderDialect(draft: DraftSource, dialect: DialectId): BundleFile {
  switch (dialect) {
    case "agents_md":
      /**
       * No frontmatter, by specification.
       *
       * AGENTS.md is plain markdown; the identity that lives in SKILL.md's YAML has to be
       * carried by the document itself, so the name becomes the leading heading and the
       * description becomes the opening line. That is also exactly the fallback chain the
       * normalizer uses to read one back, so a round trip keeps its identity.
       */
      return {
        path: "AGENTS.md",
        content: Buffer.from(
          `# ${draft.name}\n\n${draft.description}\n\n${draft.body}\n`,
          "utf8",
        ),
      };

    case "cursor_rule":
      /**
       * Cursor's own frontmatter keys, not ours.
       *
       * `description` is what Cursor matches on, `globs` scopes the rule to file patterns
       * and `alwaysApply: false` keeps it description-triggered rather than injected into
       * every request. Empty globs plus description-triggered is the closest equivalent to
       * how a skill behaves, and guessing globs from a skill that never mentioned file
       * types would silently narrow when it applies.
       */
      return {
        path: `${draft.slug}.mdc`,
        content: Buffer.from(
          `---\ndescription: ${yamlString(draft.description)}\nglobs:\nalwaysApply: false\n---\n\n${draft.body}\n`,
          "utf8",
        ),
      };

    case "anthropic_skill":
    default:
      return {
        path: "SKILL.md",
        content: Buffer.from(
          `---\nname: ${draft.slug}\ndescription: ${yamlString(draft.description)}\n---\n\n${draft.body}\n`,
          "utf8",
        ),
      };
  }
}

/**
 * Quotes a scalar so YAML cannot reinterpret it.
 *
 * Not paranoia: ten skills in the corpus were quarantined for exactly this, where a colon
 * inside an unquoted description — `Digest of posts on [REPLACE: TOPIC]` — made the parser
 * read a nested mapping and reject the document. Emitting descriptions unquoted would have
 * the builder manufacture the same defect the validator flags.
 */
function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}
