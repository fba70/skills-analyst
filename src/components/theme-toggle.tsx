"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";

/**
 * Two shapes of the same switch: a plain icon button for the public header, and a
 * sidebar menu row.
 *
 * Which icon shows is decided by CSS off the `.dark` class next-themes puts on <html>,
 * not by React state. That way the first paint is already correct — no mounted flag, no
 * hydration mismatch, no setState inside an effect.
 */
function useThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  return () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
}

export function ThemeToggleButton() {
  const toggle = useThemeSwitch();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Switch theme">
      <Moon className="size-4 dark:hidden" />
      <Sun className="hidden size-4 dark:block" />
    </Button>
  );
}

export function ThemeToggleMenuItem() {
  const toggle = useThemeSwitch();
  return (
    <SidebarMenuButton onClick={toggle} tooltip="Switch theme">
      <Moon className="dark:hidden" />
      <Sun className="hidden dark:block" />
      <span className="dark:hidden">Dark mode</span>
      <span className="hidden dark:inline">Light mode</span>
    </SidebarMenuButton>
  );
}
