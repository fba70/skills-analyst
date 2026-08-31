import Link from "next/link";

import { cn } from "@/lib/utils";
import { faqHref, faqTitle, type FaqAnchor } from "@/lib/faq";

/**
 * Makes a badge its own explanation.
 *
 * Every number on a skill page is a judgement with a rule behind it, and the rules are all
 * on `/faq`. This is the shortest path between the two: click the thing you did not
 * understand, land on the paragraph that defines it.
 *
 * ## Where this must not be used
 *
 * **Not inside anything that is already a link.** The registry list wraps each result in a
 * card-level `<Link>` to the skill, and an anchor inside an anchor is invalid HTML — React
 * will render it, browsers will disagree about what the click means, and the card's own
 * navigation becomes unpredictable. That is why the list gets one plain link near its
 * filters instead, and only the detail pages wrap individual badges.
 *
 * ## Why the badge itself, and not a "?" beside it
 *
 * A row of six badges each trailed by a question mark is a row of twelve things. The badge
 * is already the affordance a reader points at when they want to know what it means; making
 * it the target adds no visual weight at all. The accessible name carries the intent, since
 * "MIT" as link text tells a screen-reader user nothing about where it goes.
 */
export function Explain({
  anchor,
  children,
  className,
}: {
  anchor: FaqAnchor;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={faqHref(anchor)}
      aria-label={`What this means — ${faqTitle(anchor)}`}
      className={cn(
        "focus-visible:ring-ring rounded-4xl outline-hidden transition-opacity hover:opacity-80 focus-visible:ring-2",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/**
 * A plain text link into the reference, for places a badge cannot be wrapped.
 *
 * Deliberately quiet: it sits beside content that is already dense, and a reader who does
 * not need it should be able to not see it.
 */
export function ExplainLink({
  anchor,
  children,
  className,
}: {
  anchor: FaqAnchor;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={faqHref(anchor)}
      className={cn(
        "text-muted-foreground hover:text-foreground text-xs underline underline-offset-4",
        className,
      )}
    >
      {children ?? `What does this mean?`}
    </Link>
  );
}
