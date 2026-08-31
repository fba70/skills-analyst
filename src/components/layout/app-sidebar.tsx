import Link from "next/link";

import { Logo } from "@/components/brand";
import { NavAdmin, NavMain } from "@/components/layout/nav-main";
import { NavUser, type NavUserProps } from "@/components/layout/nav-user";
import { ThemeToggleMenuItem } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";

export type AppSidebarProps = {
  user: NavUserProps;
  /** System admin, resolved on the server. Gates the Administration group. */
  isAdmin?: boolean;
};

/**
 * Server component: the session data arrives as props from the protected layout, so
 * the sidebar renders complete on first paint. Only the interactive rows below are
 * client components.
 */
export function AppSidebar({ user, isAdmin = false }: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Deliberately not a SidebarMenuButton: that component forces every nested
            svg to 16px, which is too small for a brand lockup. A plain link keeps the
            mark at full size and still collapses to a centred icon. */}
        <Link
          href="/dashboard"
          aria-label="Skills Foundry"
          className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex items-center gap-3 overflow-hidden rounded-md px-1.5 py-1.5 transition-colors outline-hidden focus-visible:ring-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0"
        >
          <Logo className="size-11 shrink-0 group-data-[collapsible=icon]:size-8" />
          <span className="truncate text-2xl font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Skills Foundry
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <NavMain />
        {isAdmin ? <NavAdmin /> : null}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeToggleMenuItem />
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        {/*
          The workspace row used to sit here above the user.

          It was removed rather than hidden: every user has exactly one organisation, made
          for them on sign-up, and there is no switcher and nothing to switch to. A control
          whose only state is the state you are already in is noise in the densest part of
          the sidebar. The user row carries identity, account and sign-out, which is what
          this corner is actually for.

          Bring it back when workspaces become something a person belongs to more than one
          of — the component (`NavOrganization`) is still there and still correct.
        */}
        <SidebarMenu>
          <NavUser {...user} />
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
