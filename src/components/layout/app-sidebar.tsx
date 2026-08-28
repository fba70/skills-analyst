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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";

export type AppSidebarProps = {
  user: NavUserProps;
  organization: { name: string; role: string } | null;
};

/**
 * Server component: the session data arrives as props from the protected layout, so
 * the sidebar renders complete on first paint. Only the interactive rows below are
 * client components.
 */
export function AppSidebar({ user, organization }: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Skill Foundry">
              <Link href="/dashboard">
                <Logo className="size-6 shrink-0" />
                <span className="font-semibold tracking-tight">Skill Foundry</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavMain />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeToggleMenuItem />
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        <SidebarMenu>
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
