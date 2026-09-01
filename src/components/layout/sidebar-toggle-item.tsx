"use client";

import { PanelLeft } from "lucide-react";

import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";

/**
 * The sidebar's own collapse control, as a row inside it.
 *
 * It used to live in a top stripe that held nothing else, so every page carried a 56px
 * band of chrome to house one button. Moved here, the band goes away and the control sits
 * with the other one of its kind — the theme switch, directly above it.
 *
 * ## Why this is safe to put inside the thing it hides
 *
 * On desktop the sidebar is `collapsible="icon"`: collapsing leaves an icon rail, so this
 * button stays visible and becomes the way back. On **mobile** it is a Sheet, and a closed
 * Sheet is gone entirely — a trigger inside it would be unreachable, and the user would
 * have no way to open the navigation at all. That is why the header keeps a trigger at
 * mobile widths and only disappears from `md` up.
 *
 * The label follows the state rather than naming the element. "Sidebar" tells you what the
 * row is about but not what pressing it does, and a control whose effect you have to guess
 * is one you press once to find out.
 */
export function SidebarToggleItem() {
  const { state, toggleSidebar, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";

  return (
    <SidebarMenuButton
      onClick={toggleSidebar}
      tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {/* Mirrors the panel to point the way the click moves it. */}
      <PanelLeft className={collapsed ? "rotate-180" : undefined} />
      <span>Sidebar</span>
    </SidebarMenuButton>
  );
}
