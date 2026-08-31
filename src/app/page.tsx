import Link from "next/link";
import { ArrowRight, ScanSearch, ShieldCheck, Sparkles } from "lucide-react";

import { Logo, Wordmark } from "@/components/brand";
import { AgentAccess } from "@/components/landing/agent-access";
import { CorpusStats } from "@/components/landing/corpus-stats";
import { Principles } from "@/components/landing/principles";
import { TheLoop } from "@/components/landing/the-loop";
import { ThemeToggleButton } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getSession } from "@/server/dal/session";
import { platformStats } from "@/server/dal/stats";

const pillars = [
  {
    icon: ScanSearch,
    title: "Ingest with provenance",
    body: "Skills from many sources, normalised into one schema, every artifact carrying its origin, licence and content hash.",
  },
  {
    icon: ShieldCheck,
    title: "Validate before serving",
    body: "Layered security and quality gates that fail closed. Every verdict keeps the evidence and the analyser version that produced it.",
  },
  {
    icon: Sparkles,
    title: "Build from what works",
    body: "Structural archetypes mined per category, so a new skill starts from proof instead of a blank file.",
  },
];

export default async function HomePage() {
  /**
   * Both in parallel: the session decides which buttons render, the stats are the page's
   * evidence, and neither waits on the other.
   *
   * The stats are queried live rather than cached. They are cheap aggregates at this size,
   * and the DAL makes the argument for keeping them live — a freshness metric served from a
   * stale cache is self-defeating. This is the highest-traffic page in the product, so it
   * is also the first place that will need a cache; the answer then is a short revalidate
   * on `platformStats`, not a second copy of these numbers.
   */
  const [session, stats] = await Promise.all([getSession(), platformStats()]);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="min-w-0 text-base">
          {/* Below 360px the name steps aside — the header buttons need the room, and
              the hero lockup right underneath carries the name anyway. */}
          <Wordmark nameClassName="hidden min-[360px]:inline" />
        </Link>
        <nav className="flex shrink-0 items-center gap-1 sm:gap-2">
          {/*
            The same three destinations the anonymous shell in `(public)/layout.tsx`
            offers, in the same order. All three are public (R8.1), and the home page was
            the one surface that hid two of them — which made the FAQ and the archetypes
            read as parts of a signed-in area they have never been in.
          */}
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <Link href="/skills">Registry</Link>
          </Button>
          <Button asChild variant="ghost" className="hidden md:inline-flex">
            <Link href="/archetypes">Archetypes</Link>
          </Button>
          {/* FAQ never steps aside. It is three characters wide, and it is the one
              destination that explains what every badge and number on this page means —
              a reader on a phone needs it more than a wide-screen one, not less. */}
          <Button asChild variant="ghost">
            <Link href="/faq">FAQ</Link>
          </Button>
          <ThemeToggleButton />
          {session ? (
            <Button asChild>
              <Link href="/dashboard">
                Dashboard
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <>
              {/* Both routes are one tap away in the hero, so the secondary link can
                  step aside on a phone rather than crowd the header. */}
              <Button asChild variant="ghost" className="hidden sm:inline-flex">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button asChild>
                <Link href="/sign-up">Sign up</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center gap-12 px-4 py-12 sm:gap-16 sm:px-6 sm:py-16">
        <section className="grid gap-5 sm:gap-6">
          <div className="flex items-center gap-3 sm:gap-4">
            <Logo className="text-foreground size-11 shrink-0 sm:size-14" />
            <span className="text-lg font-semibold tracking-[0.18em] uppercase sm:text-2xl sm:tracking-[0.22em]">
              Skills Foundry
            </span>
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">
            The agent-skill corpus, validated and turned back into better skills.
          </h1>
          <p className="text-muted-foreground max-w-2xl text-base sm:text-lg">
            Registries collect skills. Wizards generate them. Nothing carries what the
            corpus proves works back into creation. Skills Foundry closes that loop.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            {/*
              Browsing leads, and it leads for everyone. Every verdict, licence and
              provenance record is readable without an account — asking someone to sign up
              before they can see whether the corpus is any good inverts the argument the
              product is making.
            */}
            <Button asChild size="lg">
              <Link href="/skills">
                Browse the registry
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            {!session ? (
              <Button asChild size="lg" variant="outline">
                <Link href="/sign-up">Create an account</Link>
              </Button>
            ) : null}
          </div>
        </section>

        {/*
          Evidence second, immediately under the claim it backs.

          The hero says the corpus is validated and worth building from. The numbers are
          what makes that checkable, and a reader who has to scroll past three explanations
          to reach them has been asked to take the claim on faith first. The terms they
          contain — quarantined, licence posture, archetype — each carry a link to the FAQ
          for the reader who wants the definition rather than the number.
        */}
        <CorpusStats stats={stats} />

        {/* Subgrid is what keeps the three columns honest: icon, heading and body each
            get their own shared row, so a heading that wraps to two lines cannot push
            its own body text out of line with the others. */}
        <section className="grid gap-8 sm:grid-cols-3 sm:grid-rows-[auto_auto_1fr] sm:gap-x-8 sm:gap-y-0">
          {pillars.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="grid content-start gap-2 sm:row-span-3 sm:grid-rows-subgrid sm:gap-0"
            >
              <Icon className="text-primary size-5 sm:mb-3" />
              <h2 className="font-medium sm:mb-2">{title}</h2>
              <p className="text-muted-foreground text-sm">{body}</p>
            </div>
          ))}
        </section>

        {/*
          The mechanism, then the promises, then the evidence.

          The pillars above are three claims in one line each; a reader who wants to know
          what the thing *does* has to be told the sequence, and a reader deciding whether
          to trust it has to be told the rules before being shown numbers they have no
          frame for.
        */}
        <TheLoop />

        {/*
          Between the mechanism and the promises, because it is the answer to "so how do I
          actually use this" — a question the loop provokes and the commitments do not.
        */}
        <AgentAccess />

        <Principles />

      </main>

      <footer className="text-muted-foreground px-4 py-6 text-sm sm:px-6">
        Skills Foundry — built by Boris Fedotov — https://fba70.vercel.app/
      </footer>
    </div>
  );
}
