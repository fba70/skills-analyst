"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronsUpDown, KeyRound, LogOut, UserRound } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export type NavUserProps = {
  name: string;
  email: string;
  image: string | null;
};

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * The server already proved the session before this rendered (see the protected
 * layout). This watches it from the client too: if the session goes away in another
 * tab or expires while the page is open, the user gets moved out instead of clicking
 * into failures.
 */
export function NavUser({ name, email, image }: NavUserProps) {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const { data, isPending } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!isPending && !data && !signingOut) {
      router.replace("/sign-in");
    }
  }, [data, isPending, signingOut, router]);

  const user = {
    name: data?.user.name ?? name,
    email: data?.user.email ?? email,
    image: data?.user.image ?? image,
  };

  async function handleSignOut() {
    setSigningOut(true);
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={user.name}
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <Avatar className="size-8 rounded-lg">
              {user.image ? <AvatarImage src={user.image} alt={user.name} /> : null}
              <AvatarFallback className="rounded-lg">
                {initials(user.name || user.email)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate text-[13px] font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-[11px]">
                {user.email}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          side={isMobile ? "bottom" : "right"}
          align="end"
          sideOffset={4}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Signed in as {user.email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/account">
              <UserRound className="size-4" />
              Account
            </Link>
          </DropdownMenuItem>
          {/*
            Its own row *because it is its own page*. The first version pointed here and at
            /account, which is two labels and one destination — a menu entry has to lead
            somewhere its label predicts, or it teaches the reader the menu is unreliable.
          */}
          <DropdownMenuItem asChild>
            <Link href="/account/mcp">
              <KeyRound className="size-4" />
              MCP access
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleSignOut} disabled={signingOut}>
            <LogOut className="size-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
