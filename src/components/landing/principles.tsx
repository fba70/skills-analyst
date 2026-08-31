import Link from "next/link";

import { faqHref } from "@/lib/faq";

/**
 * The commitments, on the page where they can be held against us.
 *
 * These are the load-bearing ones — the rules that would change what the platform *is* if
 * they were dropped, rather than the design decisions behind any one screen. Each is
 * written as a promise with its reason attached, because a promise with no reason is a
 * slogan and gets quietly dropped the first time it costs something.
 *
 * Deliberately not here: pricing, tiers, competitive positioning, market sizing. A visitor
 * deciding whether to trust the corpus is not the audience for any of that, and mixing the
 * two makes the commitments read as marketing — which is exactly what would stop them being
 * believed.
 */
const principles = [
  {
    title: "The registry is public",
    body: "Every verdict, licence and provenance record is readable with no account. Asking someone to sign up before they can see whether the corpus is any good inverts the argument the platform is making.",
  },
  {
    title: "Security information is never paywalled",
    body: "Per-skill verdicts are free and public, always — including the unflattering ones. Bulk and programmatic access is what is commercial; knowing whether one skill is safe is not.",
  },
  {
    title: "No paid ranking, no rev-share marketplace",
    body: "Position is a function of quality, security tier and relevance. There is nothing to buy, so a result you see is not a result someone paid for.",
  },
  {
    title: "Evidence, not opinion",
    body: "A verdict names the analyzer and the version that produced it and keeps the finding it rests on, so it can be re-checked, appealed, and superseded with notice rather than quietly rewritten.",
  },
  {
    title: "Upstream authors never signed up for this",
    body: "Content is mirrored only where the licence permits it, attribution travels with it, and a removal request becomes a standing block consulted before every fetch — so the next sync cannot undo it.",
  },
  {
    title: "Private work never feeds public guidance",
    body: "Skills in a private workspace stay there, and no aggregate of them reaches a public archetype. What is learned across organisations is structural only — a section role survived, never what it said.",
  },
  {
    title: "Open where it counts",
    body: "The connector SDK, parsers and rule packs are Apache-2.0; the platform is AGPL-3.0 and self-hostable; archetype snapshots and corpus statistics are CC BY-SA. The code is not the moat, so it does not need to be closed.",
  },
  {
    title: "Numbers that can look bad",
    body: "Ingestion is a fraction done and the figures below say so. A pass rate sits beside the quarantine count, and downloads beside the licence mix that limits them, because a panel that can only ever flatter is marketing with a table in it.",
  },
];

export function Principles() {
  return (
    <section className="grid gap-8">
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
          What this platform commits to
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Trust is the thing being sold, so the rules that protect it are written down where
          anyone can check them against what the product actually does.
        </p>
      </div>

      {/* Two even columns of prose rather than cards: these are read in sequence, and a
          border around each would give eight equal-weight boxes competing for attention. */}
      <dl className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
        {principles.map(({ title, body }) => (
          <div key={title} className="grid gap-1">
            <dt className="font-medium">{title}</dt>
            <dd className="text-muted-foreground text-sm">{body}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm">
        <Link
          href={faqHref("validation")}
          className="hover:text-foreground underline underline-offset-4"
        >
          FAQ: what the analyzers check, and when a skill is quarantined
        </Link>
      </p>
    </section>
  );
}
