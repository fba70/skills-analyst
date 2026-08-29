/**
 * The system-admin role, as a leaf module with no imports.
 *
 * Deliberately not in `dal/admin.ts`: that module reaches the session, which reaches the
 * auth config, which needs this constant — a cycle. It also has to be importable from
 * plain scripts, which cannot load `next/navigation`.
 *
 * A **system admin** is not an organisation role. Organisation roles (owner, member) say
 * what someone may do inside their own tenant; this says what they may do to the platform.
 */

export const ADMIN_ROLE = "admin";

/** Emails granted admin automatically on sign-up. Comma-separated in ADMIN_EMAILS. */
export function bootstrapAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isBootstrapAdmin(email: string): boolean {
  return bootstrapAdminEmails().includes(email.trim().toLowerCase());
}
