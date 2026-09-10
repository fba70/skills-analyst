import "dotenv/config";
import { Client } from "pg";
const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await c.connect();
const r = await c.query<{ kind: string; subject_type: string; n: number }>(
  "select kind, subject_type, count(*)::int as n from events group by 1,2 order by 3 desc limit 30",
);
for (const x of r.rows) console.info(String(x.n).padStart(8), x.kind, "·", x.subject_type);
await c.end();
