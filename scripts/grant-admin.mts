import "dotenv/config";

import { eq } from "drizzle-orm";

import { db } from "../src/server/db";
// Concrete modules, not the barrel: `export *` does not flatten under the script
// runner's CJS interop.
import { user } from "../src/server/db/schema/auth";
import { events } from "../src/server/db/schema/events";
// The leaf role module, not the DAL: the DAL reaches next/navigation, which cannot
// load outside a Next runtime.
import { ADMIN_ROLE } from "../src/server/auth/roles";

/**
 * Grants or revokes the system-admin role from the command line.
 *
 *   pnpm admin:grant bfedotov@gmail.com
 *   pnpm admin:grant bfedotov@gmail.com --revoke
 *   pnpm admin:grant --list
 *
 * Exists because the first admin cannot be created through the admin UI — and because a
 * lockout needs a path back in that does not involve hand-editing the database.
 */

const args = process.argv.slice(2);
const email = args.find((arg) => !arg.startsWith("--"))?.toLowerCase();
const revoke = args.includes("--revoke");

async function list() {
  const rows = await db
    .select({ email: user.email, role: user.role, name: user.name })
    .from(user)
    .orderBy(user.createdAt);
  console.info("\nPlatform users");
  for (const row of rows) {
    console.info(`  ${(row.role ?? "user").padEnd(6)}  ${row.email.padEnd(30)} ${row.name}`);
  }
  console.info("");
}

if (args.includes("--list") || !email) {
  await list();
  if (!email) {
    console.info("usage: pnpm admin:grant <email> [--revoke]\n");
  }
  process.exit(0);
}

const [target] = await db.select().from(user).where(eq(user.email, email)).limit(1);
if (!target) {
  console.error(`\n  No user with email ${email}. They must sign in once first.\n`);
  process.exit(1);
}

const role = revoke ? "user" : ADMIN_ROLE;
await db.transaction(async (tx) => {
  await tx.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, target.id));
  await tx.insert(events).values({
    actorType: "system",
    actorId: "cli",
    kind: "user.role_changed",
    subjectType: "user",
    subjectId: target.id,
    reason: `role set to ${role} from the command line`,
    payload: { role, email },
  });
});

console.info(`\n  ${email} is now ${role === ADMIN_ROLE ? "a system admin" : "a regular user"}.\n`);
await list();
