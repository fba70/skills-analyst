import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { McpTokens } from "@/components/account/mcp-tokens";
import { Button } from "@/components/ui/button";
import { getDocsOrigin } from "@/lib/app-url";
import { requireSession } from "@/server/dal/session";
import { listTokens } from "@/server/mcp/tokens";

export const metadata: Metadata = { title: "MCP access" };

/**
 * MCP access, on its own route (Doc 2 R8.8).
 *
 * It started as a card on `/account`, reached by a second menu row that pointed at the same
 * page as the first — two destinations, one page, and no way for a reader to tell what the
 * difference was meant to be. A menu entry has to lead somewhere its label predicts.
 *
 * Its own page is the right split rather than the cheap one. This is the only part of the
 * account area a person arrives *looking* for: they have read the FAQ, decided to wire an
 * agent up, and want the token. It also gives the FAQ and the landing page a stable URL to
 * send someone to, instead of a fragment that depends on a card's position.
 */
export default async function McpAccessPage() {
  // Re-resolved here, not inherited from the layout: every page resolves its own session.
  await requireSession();
  const tokens = await listTokens();

  return (
    <div className="grid w-full min-w-0 gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/account">
            <ArrowLeft className="size-4" />
            Account
          </Link>
        </Button>
      </div>

      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">MCP access</h1>
        <p className="text-muted-foreground max-w-3xl">
          Tokens that let an agent query this registry directly — search the corpus, read a
          skill&rsquo;s verdicts and provenance, fetch an archetype, resolve a download. Free,
          and revocable.
        </p>
      </div>

      <McpTokens tokens={tokens} origin={getDocsOrigin()} />
    </div>
  );
}
