import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, emailOTP, organization } from "better-auth/plugins";
import { localization } from "better-auth-localization";

import { db, schema } from "@/server/db";
import { sendOtpEmail } from "@/server/mail";

import { ensurePersonalOrganization, findFirstOrganizationId } from "./personal-org";

/**
 * Passwordless by design: email plus a 6-digit code, for both sign-up and sign-in.
 * There is no password column in use, so there is no password reset to get wrong.
 *
 * GitHub OAuth is planned (it gives us the identity attribution needs) and is purely
 * additive — the `account` table already carries it.
 */
/** "ada.lovelace@example.com" -> "Ada Lovelace". A placeholder the user can replace. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || local || "New user";
}

export const auth = betterAuth({
  appName: "Skill Foundry",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),

  emailAndPassword: { enabled: false },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh the cookie once a day
  },

  user: {
    deleteUser: { enabled: false },
  },

  databaseHooks: {
    user: {
      create: {
        // Email-OTP sign-up carries no name, so Better Auth stores "". An empty name
        // then shows up as a blank sidebar row and a blank greeting. Fill it here once
        // instead of guarding for it in every component.
        before: async (newUser) => {
          if (newUser.name?.trim()) return;
          return { data: { ...newUser, name: nameFromEmail(newUser.email) } };
        },
        after: async (createdUser) => {
          await ensurePersonalOrganization({
            id: createdUser.id,
            name: createdUser.name,
            email: createdUser.email,
          });
        },
      },
    },
    session: {
      create: {
        // A session without an active org would make every org-scoped read a special
        // case. Resolve it once, here.
        before: async (newSession) => {
          const organizationId = await findFirstOrganizationId(newSession.userId);
          if (!organizationId) return;
          return { data: { ...newSession, activeOrganizationId: organizationId } };
        },
      },
    },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 10, // 10 minutes
      allowedAttempts: 3,
      storeOTP: "hashed",
      // false = an unknown email signs up on first successful code
      disableSignUp: false,
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        await sendOtpEmail({ to: email, code: otp, purpose: type });
      },
    }),
    admin(),
    organization({
      // Auto-created personal org aside, a user may own more later.
      allowUserToCreateOrganization: true,
      organizationLimit: 5,
    }),
    localization({
      // "default" is Better Auth's own English. Add a locale by listing it here and
      // wiring `getLocale` to read the request — no other change needed.
      defaultLocale: "default",
      fallbackLocale: "default",
    }),
    // nextCookies must stay last: it wraps the handlers that set cookies.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
