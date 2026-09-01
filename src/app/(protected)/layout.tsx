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
        {/*
          Mobile only, and that is the whole reason it still exists.
 
          The stripe used to run on every page to hold one button, which now lives in the
          sidebar footer beside the theme switch. On desktop the sidebar collapses to an
          icon rail, so the control inside it stays reachable and the band is pure cost.
 
          On mobile the sidebar is a Sheet: closed, it is gone, and a trigger inside it
          could never be pressed. So the header survives below `md` — sticky, because a
          navigation control you have to scroll back up to find is one people stop using.
        */}
        <header className="bg-background sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <SidebarTrigger className="-ml-1" />
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
