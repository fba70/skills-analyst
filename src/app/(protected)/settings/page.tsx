import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { IngestionPanel } from "@/components/settings/ingestion-panel";
import { UsersPanel } from "@/components/settings/users-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { crawlCoverage } from "@/server/crawl/run";
import { isAdmin, listPlatformUsers, platformCounts } from "@/server/dal/admin";
import { requireSession } from "@/server/dal/session";

export const metadata: Metadata = { title: "Settings" };

/**
 * System-admin settings.
 *
 * Guarded twice over: the sidebar only offers the link to admins, this page returns 404
 * for everyone else, and every action re-checks on the server. `notFound()` rather than a
 * "forbidden" page — a non-admin has no reason to learn the route exists.
 *
 * Tabs, so the surface can grow. The discovery, validation and spend policy all belong
 * here eventually — see "Admin settings" in CLAUDE.md.
 */
export default async function SettingsPage() {
  const session = await requireSession();
  if (!(await isAdmin())) notFound();

  const [users, counts, coverage] = await Promise.all([
    listPlatformUsers(),
    platformCounts(),
    crawlCoverage(),
  ]);

  const shardTotals = coverage.shards.reduce(
    (totals, row) => ({
      shards: totals.shards + row.shards,
      seen: totals.seen + row.seen,
    }),
    { shards: 0, seen: 0 },
  );

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Settings</h1>
          <Badge variant="default">system admin</Badge>
        </div>
        <p className="text-muted-foreground">
          Platform-wide administration. Distinct from workspace roles: this reaches every
          user and the ingestion pipeline.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Users" value={counts.users} detail={`${counts.admins} admin`} />
        <Stat label="Workspaces" value={counts.organizations} />
        <Stat
          label="Crawl shards"
          value={shardTotals.shards}
          detail={`${shardTotals.seen.toLocaleString()} markers seen`}
        />
      </div>

      <Tabs defaultValue="ingestion">
        <TabsList>
          <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>

        <TabsContent value="ingestion" className="mt-4">
          <IngestionPanel />
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>All users</CardTitle>
            </CardHeader>
            <CardContent className="px-0 sm:px-(--card-spacing)">
              <UsersPanel users={users} currentUserId={session.user.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}
