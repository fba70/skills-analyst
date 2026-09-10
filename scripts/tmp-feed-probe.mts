import "dotenv/config";
import { Client } from "pg";
const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await c.connect();
const { rows: skill } = await c.query<{ id: string }>(
  `select id from skills where status = 'indexed' and org_id is null limit 1`,
);
const kinds = `'skill_version.indexed','skill_version.quarantined','licence.reresolved','skill_version.tombstoned'`;

let t = Date.now();
const a = await c.query(`
  with mine as (
    select id::text as id from skill_versions where skill_id = $1::uuid
    union all select $1::text
  )
  select e.at, e.kind from events e join mine on mine.id = e.subject_id
   where e.kind in (${kinds}) and e.at > now() - interval '3650 days'
   order by e.at desc limit 100`, [skill[0].id]);
console.info(`skill watch:    ${a.rows.length} rows in ${Date.now() - t}ms`);

t = Date.now();
const b = await c.query(`
  select e.at, e.kind from events e
    join skill_versions v on v.id::text = e.subject_id
    join skills s on s.id = v.skill_id
   where e.at > now() - interval '30 days'
     and e.kind in (${kinds})
     and e.subject_type in ('skill_versions','skill_version')
     and s.org_id is null
     and exists (select 1 from skill_categories sc where sc.skill_id = s.id
                  and sc.axis = 'function' and sc.value = 'review'
                  and (sc.confidence >= 60 or sc.reviewed_at is not null))
   order by e.at desc limit 100`);
console.info(`category watch: ${b.rows.length} rows in ${Date.now() - t}ms`);
await c.end();
