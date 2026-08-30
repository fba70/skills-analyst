import Link from "next/link";

import { Logo } from "@/components/brand";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ThemeToggleButton } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { isAdmin } from "@/server/dal/admin";
import { getSession } from "@/server/dal/session";

/**
 * The public shell (Doc 2 R8.1).
 *
 * Everything under this group is readable without an account: browse, search, a skill's
 * detail page with its provenance, licence, verdicts and quality score. Doc 1 makes those
 * trust surfaces un-paywallable (RC.1); this makes them un-gated as well, which is the
 * point of a trust-first registry — a verdict nobody can read without signing up does not
 * build trust, it advertises it.
 *
 * ## `getSession`, never `requireSession`
 *
 * The distinction is the whole boundary. `requireSession()` redirects; `getSession()`
 * returns null and lets the page render. A signed-in visitor gets the full application
 * chrome — sidebar, workspace, admin links — and an anonymous one gets a plain header with
 * a sign-in button. Same registry underneath, two chromes.
 *
 * Reading the session here costs nothing extra: it is `cache()`d per request, so the pages
 * below share the one lookup. And the DAL is already correct for both cases — `withOrgScope`
 * resolves no org for an anonymous request, which lands on exactly the public corpus
 * (`org_id IS NULL`) with RLS enforcing it rather than a `where` clause anyone can forget.
 */
export default async function PublicLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  if (!session) return <AnonymousShell>{children}</AnonymousShell>;

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
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarTrigger className="-ml-1" />
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** No sidebar, no workspace — a header, the content, and a way in. */
function AnonymousShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <Link
          href="/"
          aria-label="Skill Foundry"
          className="flex items-center gap-2 overflow-hidden rounded-md transition-opacity hover:opacity-80"
        >
          <Logo className="size-8 shrink-0" />
          <span className="truncate font-semibold tracking-tight">Skill Foundry</span>
        </Link>

        <nav className="ml-4 hidden sm:flex">
          <Button asChild variant="ghost" size="sm">
            <Link href="/skills">Registry</Link>
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggleButton />
          <Button asChild variant="ghost" size="sm">
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/sign-up">Create account</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
        {children}
      </main>
    </div>
  );
}
