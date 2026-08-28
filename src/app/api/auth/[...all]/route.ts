import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/server/auth";

/**
 * The one route handler allowed to reach the database.
 *
 * Better Auth owns its own endpoints and its own writes; there is no way to hand that
 * to a server component. Both guards on the "no DB in API routes" rule — the Claude
 * Code hook in .claude/hooks/no-db-in-api.sh and the ESLint block in
 * eslint.config.mjs — allow-list this path by name. Nothing else under src/app/api
 * gets the same treatment: put the query in src/server/ and call it from a server
 * component or a server action.
 */
export const { GET, POST } = toNextJsHandler(auth);
