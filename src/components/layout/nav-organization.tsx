"use client";

import { Building2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { initials } from "@/components/layout/nav-user";

export type NavOrganizationProps = {
  name: string;
  role: string;
};

/**
 * Which workspace you are in, and what you are in it. Read-only for now — the switcher
 * arrives with the second organization.
 */
export function NavOrganization({ name, role }: NavOrganizationProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" tooltip={`${name} · ${role}`}>
        <Avatar className="size-8 rounded-lg">
          <AvatarFallback className="bg-primary text-primary-foreground rounded-lg text-xs">
            {name ? initials(name) : <Building2 className="size-4" />}
          </AvatarFallback>
        </Avatar>
        <div className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium">{name}</span>
          <span className="text-muted-foreground truncate text-xs capitalize">
            {role}
          </span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
