"use client";

import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  emailOTPClient,
  organizationClient,
} from "better-auth/client/plugins";

import { getAppUrl } from "@/lib/app-url";

/**
 * Browser-side client. The plugin list mirrors the server in
 * `src/server/auth/index.ts` — they must stay in step, or client calls hit routes that
 * do not exist.
 *
 * `betterAuthLocalizationClientPlugin` is deliberately absent. It is a runtime no-op
 * (`{ id: "localization", $InferServerPlugin: {} }`) and that empty `$InferServerPlugin`
 * collapses the inferred session type to `never`, so `useSession().data.user` stops
 * type-checking. Localization happens in the server plugin's `after` hook, which
 * rewrites error messages before they reach the browser — nothing is lost here.
 */
export const authClient = createAuthClient({
  baseURL: getAppUrl(),
  plugins: [emailOTPClient(), adminClient(), organizationClient()],
});

export const { useSession, signOut } = authClient;
