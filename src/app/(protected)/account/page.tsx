import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getActiveOrganization } from "@/server/dal/organizations";
import { requireSession } from "@/server/dal/session";
import { listTokens } from "@/server/mcp/tokens";

export const metadata: Metadata = { title: "Account" };

function titleCase(value: string | undefined): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function AccountPage() {
  const session = await requireSession();
  const [organization, tokens] = await Promise.all([getActiveOrganization(), listTokens()]);
  const activeTokens = tokens.filter((token) => token.revokedAt === null).length;

  const rows: Array<{ label: string; value: string }> = [
    { label: "Name", value: session.user.name },
    { label: "Email", value: session.user.email },
    { label: "Sign-in method", value: "Email code" },
    { label: "Workspace", value: organization?.name ?? "—" },
    { label: "Role in workspace", value: titleCase(organization?.role) },
  ];

  return (
    <div className="grid w-full min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Account</h1>
        <p className="text-muted-foreground max-w-3xl">Your profile and workspace.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          {session.user.emailVerified ? (
            <CardAction>
              <Badge variant="secondary">Email verified</Badge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            {rows.map((row) => (
              <div
                key={row.label}
                className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:gap-4"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-medium wrap-break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {/*
        MCP access lives on the account page rather than in Settings, because it is a
        workspace credential and not a platform control: any member may mint one, and
        Settings is admin-only three times over.
      */}
      {/*
        A pointer, not the panel.

        Token management is its own route: it is the part of the account area people arrive
        looking for, and a menu entry that leads to the same page as the one above it tells a
        reader nothing. The count is here because "do I have any" is the question this page
        should answer without a click.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <KeyRound className="text-muted-foreground size-4" />
            MCP access
            <Badge variant="secondary">free</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-muted-foreground max-w-2xl text-sm">
            {/* "No tokens yet" and "none that still work" are different facts, and a
                workspace whose only token was just revoked would be told the wrong one. */}
            Let an agent query this registry directly.{" "}
            {activeTokens > 0
              ? `${activeTokens} active token${activeTokens === 1 ? "" : "s"}.`
              : tokens.length > 0
                ? "No active tokens — every one has been revoked."
                : "No tokens yet."}
          </p>
          <div>
            <Button asChild size="sm">
              <Link href="/account/mcp">Manage MCP tokens</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
