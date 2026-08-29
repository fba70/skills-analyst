"use client";

import { useTransition } from "react";
import { ShieldCheck, ShieldOff, UserRoundX, UserRoundCheck } from "lucide-react";
import { toast } from "sonner";

import { setBannedAction, setRoleAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PlatformUser } from "@/server/dal/admin";

/**
 * Every user on the platform — not org-scoped, which is the whole point of a system
 * admin.
 *
 * The two destructive-ish controls guard against the obvious foot-guns in the DAL rather
 * than only in the UI: an admin cannot remove their own admin role or ban themselves, so
 * disabling the buttons here is a courtesy, not the enforcement.
 */
export function UsersPanel({
  users,
  currentUserId,
}: {
  users: PlatformUser[];
  currentUserId: string;
}) {
  const [isPending, startTransition] = useTransition();

  function run(label: string, action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) toast.success(label, { description: result.message });
      else toast.error(label, { description: result.message });
    });
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="hidden sm:table-cell">Workspaces</TableHead>
            <TableHead className="hidden md:table-cell">Joined</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            const isAdmin = user.role === "admin";
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="grid gap-0.5">
                    <span className="font-medium">{user.name}</span>
                    <span className="text-muted-foreground text-xs">{user.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={isAdmin ? "default" : "outline"} className="text-xs">
                      {isAdmin ? "system admin" : "user"}
                    </Badge>
                    {user.banned ? (
                      <Badge variant="destructive" className="text-xs">
                        banned
                      </Badge>
                    ) : null}
                    {isSelf ? (
                      <Badge variant="outline" className="text-muted-foreground text-xs">
                        you
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">{user.organizations}</TableCell>
                <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                  {user.createdAt.toISOString().slice(0, 10)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending || (isSelf && isAdmin)}
                      onClick={() =>
                        run("Role", () =>
                          setRoleAction(user.id, isAdmin ? "user" : "admin"),
                        )
                      }
                    >
                      {isAdmin ? (
                        <ShieldOff className="size-4" />
                      ) : (
                        <ShieldCheck className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {isAdmin ? "Revoke admin" : "Make admin"}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending || isSelf}
                      onClick={() =>
                        run("Access", () => setBannedAction(user.id, !user.banned))
                      }
                    >
                      {user.banned ? (
                        <UserRoundCheck className="size-4" />
                      ) : (
                        <UserRoundX className="size-4" />
                      )}
                      <span className="hidden sm:inline">
                        {user.banned ? "Unban" : "Ban"}
                      </span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
