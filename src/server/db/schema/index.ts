/**
 * Every table in one namespace. App tables (sources, skills, skill_versions,
 * verdicts, archetypes, events, …) get their own files next to `auth.ts` and are
 * re-exported here.
 */
export * from "./auth";
