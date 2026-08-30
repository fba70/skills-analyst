import { AppSidebar } from "@/components/layout/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { isAdmin } from "@/server/dal/admin";
import { requireSession } from "@/server/dal/session";

/**
 * The server-side auth boundary for everything in this group.
 *
 * `src/proxy.ts` redirects unauthenticated traffic earlier for a snappier feel, but
 * this check is the one that counts — and every server action below re-checks for
 * itself, because a POST can reach an action without passing a proxy matcher.
 */
export default async function ProtectedLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  // Only the admin flag is needed now that the sidebar no longer shows a workspace row.
  // Keeping the organisation lookup would be a query per render for data nothing renders.
  const admin = await isAdmin();

  return (
    <SidebarProvider>
      <AppSidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          image: session.user.image ?? null,
        }}
        isAdmin={admin}
      />
      <SidebarInset className="min-w-0">
        {/* Breadcrumbs land here once there is more than one page to point at. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarTrigger className="-ml-1" />
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
