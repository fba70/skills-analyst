import Link from "next/link";
import { Terminal } from "lucide-react";

import { faqHref } from "@/lib/faq";

/**
 * MCP, on the front door (Doc 2 R8.8).
 *
 * ## Why this earns a section rather than a line in the FAQ
 *
 * Most of what this corpus is for will be read by an agent, not by a person. The rest of the
 * page argues to a human deciding whether to trust the registry; this is the one part that
 * tells that human their tools can use it directly, which is the difference between "a site I
 * might browse" and "a thing I can wire into my setup this afternoon".
 *
 * It states the account requirement plainly instead of burying it. Discovering a login wall
 * *after* deciding to integrate is how a free tier gets read as a bait-and-switch — and the
 * reason for it is good, so it can be said out loud in one sentence.
 */
const tools = [
  { name: "search_skills", body: "Structured filters — function, domain, capability, licence, minimum quality." },
  { name: "get_skill", body: "Verdicts with analyzer versions, provenance, licence chain, capability surface." },
  { name: "download_skill", body: "A bundle URL, or a refusal that says whether it is worth retrying." },
  { name: "get_archetype", body: "What a good skill in a category looks like, with the lift behind each section." },
];

export function AgentAccess() {
  return (
    <section className="grid gap-8">
      <div className="grid gap-2">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
          <Terminal className="text-primary size-5" aria-hidden />
          Your agent can read this directly
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          There is an MCP server at <code className="text-xs">/api/mcp</code>. An agent can
          search the corpus, read a skill&rsquo;s verdicts and provenance, and fetch an
          archetype without a person in the loop — which is how most of this will be used.
        </p>
      </div>

      <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {tools.map(({ name, body }) => (
          <div key={name} className="grid gap-1">
            <dt className="font-mono text-sm font-medium">{name}</dt>
            <dd className="text-muted-foreground text-sm">{body}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-2">
        <p className="text-muted-foreground max-w-2xl text-sm">
          <span className="text-foreground">Free, and it needs a free account.</span> Not a
          paywall — a name to count requests against. An anonymous caller offers only an IP
          address, shared by everyone behind one router and changed by anyone who wants to, so
          a limit built on it bounds accidents and nothing else. Nothing behind the token is
          hidden from the web: every verdict it returns is on a public page.
        </p>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Skill text comes back inside a labelled fence carrying its source, status and score
          — data to be evaluated, never instructions to follow — alongside the capability
          surface saying whether the bundled code touches the network, files, a shell or
          credentials.
        </p>
      </div>

      <p className="text-sm">
        <Link href={faqHref("mcp")} className="hover:text-foreground underline underline-offset-4">
          FAQ: the tools, the limits, and what is free versus paid
        </Link>
      </p>
    </section>
  );
}
