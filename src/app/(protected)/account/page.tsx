import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getActiveOrganization } from "@/server/dal/organizations";
import { requireSession } from "@/server/dal/session";

export const metadata: Metadata = { title: "Account" };

function titleCase(value: string | undefined): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default async function AccountPage() {
  const session = await requireSession();
  const organization = await getActiveOrganization();

  const rows: Array<{ label: string; value: string }> = [
    { label: "Name", value: session.user.name },
    { label: "Email", value: session.user.email },
    { label: "Sign-in method", value: "Email code" },
    { label: "Workspace", value: organization?.name ?? "—" },
    { label: "Role in workspace", value: titleCase(organization?.role) },
  ];

  return (
    <div className="grid w-full max-w-2xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Account</h1>
        <p className="text-muted-foreground">Your profile and workspace.</p>
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
                <dd className="font-medium break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
