"use client";

import { useState, useTransition } from "react";
import { Copy, KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { createTokenAction, revokeTokenAction } from "@/app/(protected)/account/actions";
import type { IssuedToken, TokenSummary } from "@/server/mcp/tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * MCP access, on the account page (Doc 2 R8.8).
 *
 * ## The token is shown once, and the UI has to be honest about that
 *
 * Only `sha256(token)` is stored, so there is no "show again". A panel that hid the value
 * behind a copy button for later would be describing a table that does not exist. The
 * freshly-minted token therefore gets its own block, stays until dismissed, and says plainly
 * that it will not be shown again — the one place where an extra sentence is worth more than
 * a tidier layout.
 *
 * ## Revoked rows stay listed
 *
 * They answer "was there a credential, and when did it stop working". Hiding them would make
 * the list shorter and the audit trail worse.
 */
export function McpTokens({ tokens, origin }: { tokens: TokenSummary[]; origin: string }) {
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [isPending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const outcome = await createTokenAction(name);
      if (!outcome.ok) {
        toast.error("MCP token", { description: outcome.message });
        return;
      }
      setIssued(outcome.issued);
      setName("");
      toast.success("MCP token created", { description: "Copy it now — it is not shown again." });
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      const outcome = await revokeTokenAction(id);
      if (outcome.ok) toast.success("MCP token", { description: outcome.message });
      else toast.error("MCP token", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <KeyRound className="text-muted-foreground size-4" />
          MCP access
          <Badge variant="secondary">free</Badge>
        </CardTitle>
        <CardDescription>
          Let an agent query this registry directly — search, read verdicts and provenance,
          fetch archetypes, resolve a download. The endpoint is{" "}
          <code className="text-xs">/api/mcp</code>, and a token identifies you so the rate
          limit has something real to count against. It costs nothing and unlocks nothing you
          could not already read on a public page.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {issued ? (
          <div className="border-primary/40 bg-muted/40 grid min-w-0 gap-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Copy this now — it will not be shown again.</p>
            <code className="bg-background min-w-0 overflow-x-auto rounded px-3 py-2 font-mono text-xs">
              {issued.token}
            </code>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.token);
                  toast.success("Copied");
                }}
              >
                <Copy className="size-4" />
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                Done
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Only a hash of it is stored, which is why nothing here can show it again. Lost
              it? Revoke this one and create another.
            </p>
          </div>
        ) : null}

        <div className="grid gap-2 sm:max-w-md">
          <Label htmlFor="token-name">New token</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="token-name"
              placeholder="What is it for — laptop, CI, an agent"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button onClick={create} disabled={isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create
            </Button>
          </div>
        </div>

        {tokens.length > 0 ? (
          <ul className="grid gap-2">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-sm first:border-t-0 first:pt-0"
              >
                <span className="min-w-0 truncate font-medium">{token.name}</span>
                <code className="text-muted-foreground shrink-0 font-mono text-xs">
                  {token.prefix}…
                </code>
                {token.revokedAt ? (
                  <Badge variant="outline">revoked</Badge>
                ) : (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {token.lastUsedAt
                      ? `last used ${token.lastUsedAt.toLocaleDateString()}`
                      : "never used"}
                  </span>
                )}
                {token.revokedAt === null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={isPending}
                    onClick={() => revoke(token.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            No tokens yet. Create one above to connect an agent.
          </p>
        )}

        <details className="min-w-0 text-sm">
          <summary className="cursor-pointer font-medium">How to connect an agent</summary>
          <div className="text-muted-foreground mt-2 grid min-w-0 gap-2">
            <p>Point any MCP client at the endpoint and send the token as a bearer header:</p>
            <pre className="bg-muted/60 min-w-0 overflow-x-auto rounded-md p-3 font-mono text-xs">
              {`{
  "mcpServers": {
    "skills-foundry": {
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer sf_mcp_…" }
    }
  }
}`}
            </pre>
            <p>
              Six tools: <code className="text-xs">search_skills</code>,{" "}
              <code className="text-xs">get_skill</code>,{" "}
              <code className="text-xs">download_skill</code>,{" "}
              <code className="text-xs">list_archetypes</code>,{" "}
              <code className="text-xs">get_archetype</code>,{" "}
              <code className="text-xs">corpus_stats</code>.
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
