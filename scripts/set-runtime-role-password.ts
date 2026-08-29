import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

/**
 * Sets the password on the `app_runtime` role and points DATABASE_URL at it.
 *
 * This is not a migration on purpose: migration files are committed, and a password in
 * git is a password that has leaked. Migration 0002 creates the role with no password;
 * this script gives it one and writes the resulting URL into .env.
 *
 * Run with the OWNER connection (DATABASE_URL_UNPOOLED). Safe to re-run — it rotates the
 * password and rewrites .env to match.
 *
 *   pnpm db:role-password
 */

const ROLE = "app_runtime";
const ENV_FILE = ".env";

function ownerUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL_UNPOOLED (owner connection) first");
  return url;
}

/** Password-safe characters only: this value ends up inside a URL. */
function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** Same host and database as the owner URL, different credentials. */
function runtimeUrlFrom(templateUrl: string, password: string): string {
  const url = new URL(templateUrl);
  url.username = ROLE;
  url.password = password;
  return url.toString();
}

function upsertEnvVar(contents: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents}\n${line}\n`;
}

async function main() {
  const owner = ownerUrl();
  const password = generatePassword();

  const client = new Client({ connectionString: owner });
  await client.connect();
  try {
    // ALTER ROLE takes no bind parameters, so ask the server to build the statement with
    // its own quoting (format %I/%L) and then run what it hands back. Never string
    // concatenation on our side.
    const { rows } = await client.query<{ stmt: string }>(
      "select format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) as stmt",
      [ROLE, password],
    );
    await client.query(rows[0].stmt);
  } finally {
    await client.end();
  }

  // The app talks to the POOLED endpoint; migrations keep the unpooled owner URL.
  const pooledTemplate = process.env.DATABASE_URL ?? owner;
  const runtimeUrl = runtimeUrlFrom(pooledTemplate, password);

  const verify = new Client({ connectionString: runtimeUrl });
  await verify.connect();
  const { rows } = await verify.query(
    "select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls",
  );
  await verify.end();

  if (rows[0].bypassrls) {
    throw new Error(`${ROLE} has BYPASSRLS — policies would not apply. Aborting.`);
  }

  const env = readFileSync(ENV_FILE, "utf8");
  writeFileSync(ENV_FILE, upsertEnvVar(env, "DATABASE_URL", runtimeUrl));

  console.info(
    [
      "",
      `  ${ROLE} password set and verified.`,
      `  connected as: ${rows[0].current_user} (bypassrls: ${rows[0].bypassrls})`,
      `  DATABASE_URL in ${ENV_FILE} now points at ${ROLE} (pooled endpoint).`,
      `  DATABASE_URL_UNPOOLED still owns migrations.`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
