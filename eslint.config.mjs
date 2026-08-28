import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Database access boundary.
 *
 * Route handlers under src/app/api/** must not touch the database. Queries live in
 * src/server/** and are called from server components and server actions, where the
 * session and the org are resolved by the DAL.
 *
 * The single exception is src/app/api/auth/**: Better Auth owns its own endpoints and
 * its own writes, and there is no way to move that into a server component.
 *
 * A Claude Code hook (.claude/hooks/no-db-in-api.sh) blocks the edit while it is being
 * written; this rule fails `pnpm lint` and the build for everything the hook misses.
 */
const bannedInApiRoutes = [
  { name: "pg", message: "Route handlers must not talk to Postgres." },
  { name: "drizzle-orm", message: "Route handlers must not query the database." },
  { name: "@/server/db", message: "Import the DAL from a server component instead." },
];

const dbBoundary = {
  files: ["src/app/api/**/*.{ts,tsx,js,jsx}"],
  ignores: ["src/app/api/auth/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: bannedInApiRoutes,
        patterns: [
          {
            group: ["@/server/db", "@/server/db/**", "drizzle-orm/**", "pg/**"],
            message:
              "No database access from API routes. Put the query in src/server/ and call it from a server component or server action.",
          },
        ],
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  dbBoundary,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "migrations/**",
  ]),
]);

export default eslintConfig;
