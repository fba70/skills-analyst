import Link from "next/link";

import { Logo } from "@/components/brand";
import { NavMain } from "@/components/layout/nav-main";
import { NavOrganization } from "@/components/layout/nav-organization";
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
  organization: { name: string; role: string } | null;
  /** System admin, resolved on the server. Gates the Administration group. */
  isAdmin?: boolean;
};

/**
 * Server component: the session data arrives as props from the protected layout, so
 * the sidebar renders complete on first paint. Only the interactive rows below are
 * client components.
 */
export function AppSidebar({ user, organization, isAdmin = false }: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* Deliberately not a SidebarMenuButton: that component forces every nested
            svg to 16px, which is too small for a brand lockup. A plain link keeps the
            mark at full size and still collapses to a centred icon. */}
        <Link
          href="/dashboard"
          aria-label="Skill Foundry"
          className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex items-center gap-3 overflow-hidden rounded-md px-1.5 py-1.5 transition-colors outline-hidden focus-visible:ring-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0"
        >
          <Logo className="size-11 shrink-0 group-data-[collapsible=icon]:size-8" />
          <span className="truncate text-2xl font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Skill Foundry
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <NavMain isAdmin={isAdmin} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeToggleMenuItem />
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        {/* gap-2: SidebarMenu ships with gap-0, which left these two rows touching. */}
        <SidebarMenu className="gap-2">
          {organization ? (
            <NavOrganization name={organization.name} role={organization.role} />
          ) : null}
          <NavUser {...user} />
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
