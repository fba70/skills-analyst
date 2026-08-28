import type { Metadata } from "next";

import { requireSession } from "@/server/dal/session";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // Re-checked here, not inherited from the layout: every page and action resolves the
  // session itself. It is cached per request, so this costs nothing.
  const session = await requireSession();
  const firstName = session.user.name.split(/\s+/)[0] || session.user.email;

  return (
    <div className="grid gap-2">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Dashboard</h1>
      <p className="text-muted-foreground">
        Welcome back, {firstName}. Nothing to show yet — corpus, verdicts and loop
        health land here.
      </p>
    </div>
  );
}
