"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, type LucideIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

/** The main menu. One entry today; the registry, builder and assistant land here. */
const items: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
];

export function NavMain() {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                <Link href={item.href}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
