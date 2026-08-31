/**
 * The reference page's sections, named once.
 *
 * A leaf module with no imports, because two things need to agree: `/faq` renders these as
 * its headings and its jump navigation, and badges elsewhere link into them. A hand-typed
 * `#quality` in a badge is a link that silently scrolls nowhere the day a section is
 * renamed — and a broken explanation is worse than an unexplained badge, because the reader
 * has already decided to trust the answer before finding there isn't one.
 *
 * Typing the anchor turns that failure into a compile error.
 */

export const FAQ_SECTIONS = [
  { id: "quality", title: "Quality score" },
  { id: "validation", title: "Validation" },
  { id: "licences", title: "Licences" },
  { id: "capabilities", title: "Capabilities" },
  { id: "categories", title: "Categories" },
  { id: "archetypes", title: "Archetypes" },
  { id: "duplicates", title: "Duplicates" },
  { id: "mcp", title: "Agent access (MCP)" },
] as const;

export type FaqAnchor = (typeof FAQ_SECTIONS)[number]["id"];

export function faqHref(anchor: FaqAnchor): string {
  return `/faq#${anchor}`;
}

/** The section's own title, for a link's accessible name. */
export function faqTitle(anchor: FaqAnchor): string {
  return FAQ_SECTIONS.find((section) => section.id === anchor)!.title;
}
