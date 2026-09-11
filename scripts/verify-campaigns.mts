import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  CAMPAIGN_REFUSAL_MESSAGE,
  CAMPAIGN_REFUSALS,
  capturedShare,
  MAX_TOPICS,
  TOPIC_STATE_META,
  TOPIC_STATES,
  topicState,
} from "../src/lib/campaigns";
import { PLAN_FEATURES } from "../src/lib/plans";

/**
 * A campaign has a denominator, and it counts nothing itself (Doc 6 RK.8, plan step E7).
 *
 *   pnpm verify:campaigns
 *
 * Free. The stored half creates a real campaign, topic and draft through the real functions and
 * removes them in a `finally`.
 *
 * ## The two properties this file exists to protect
 *
 * 1. **Progress is derived, never stored.** There is no counter column and no job maintaining
 *    one. A stored count drifts the first time somebody publishes a draft without coming back to
 *    the campaign, which is the normal way work happens — and it drifts in the flattering
 *    direction, because nobody notices a progress bar that is too high.
 * 2. **An empty campaign is not 0% complete.** *Nothing captured* and *nothing asked for* are
 *    the same zero and opposite meanings, and a bar at 0% on a campaign with no topics reads as
 *    failure where it should read as unstarted. The same distinction the endorsement card and
 *    `archetypes --blocks` both had to learn.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe denominator, and the two kinds of zero");

check(
  "an empty campaign has no share, rather than a share of nothing",
  capturedShare({ topics: 0, drafting: 0, published: 0, interviews: 0, distillRuns: 0, accepted: 0 }) === null,
  "0% on a campaign nobody has scoped reads as failure where it should read as unstarted",
);
check(
  "and a real campaign does",
  capturedShare({ topics: 4, drafting: 1, published: 1, interviews: 0, distillRuns: 0, accepted: 0 }) === 25,
);
check(
  "a topic's state comes from its draft, not from a column",
  topicState({ draftId: null, publishedSkillId: null }) === "not-started" &&
    topicState({ draftId: "d", publishedSkillId: null }) === "drafting" &&
    topicState({ draftId: "d", publishedSkillId: "s" }) === "published",
);
check(
  "every state has its own sentence",
  TOPIC_STATES.length === 3 &&
    new Set(TOPIC_STATES.map((s) => TOPIC_STATE_META[s].blurb)).size === 3,
);
check(
  "every refusal has its own sentence",
  new Set(CAMPAIGN_REFUSALS.map((r) => CAMPAIGN_REFUSAL_MESSAGE[r])).size === CAMPAIGN_REFUSALS.length,
  `${CAMPAIGN_REFUSALS.length} refusals`,
);
check(
  "a campaign is a programme, not a backlog",
  MAX_TOPICS > 0 && MAX_TOPICS <= 100,
  `${MAX_TOPICS} topics — more than that has no end date`,
);

console.info("\nNothing new underneath it");

const run = readFileSync(join(process.cwd(), "src/server/campaigns/run.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

check(
  "the module captures nothing itself",
  !/generateText|streamText|embedBatch|setDraftBlocks|importDraftBody/.test(run),
  "Interview and Distill do the capturing; a campaign only says whether it is finished",
);
check(
  "and stores no progress",
  !/progress:\s*\d|published_count|topic_count|set\(\{[^}]*count/.test(run),
  "a stored count drifts the first time somebody publishes without telling the campaign",
);
check(
  "it is Team, and free gets none of it",
  PLAN_FEATURES.team.includes("capture-campaigns") &&
    !PLAN_FEATURES.free.includes("capture-campaigns") &&
    !PLAN_FEATURES.pro.includes("capture-campaigns"),
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.capture_campaigns') is not null
        and to_regclass('public.campaign_topics') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  tables absent — the migration is not applied yet");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name in ('capture_campaigns','campaign_topics')`,
    );
    check(
      "no column holds a count or a topic status",
      !columns.some((col) => /count|progress|topic_state|captured/.test(col.column_name)),
      "the whole design: derived on read, so it cannot drift",
    );
    check(
      "deleting a draft cannot shrink a campaign's denominator",
      (
        await c.query<{ delete_rule: string }>(
          `select rc.delete_rule from information_schema.referential_constraints rc
             join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
            where tc.table_name = 'campaign_topics' and tc.constraint_name like '%draft%'`,
        )
      ).rows[0]?.delete_rule === "SET NULL",
      "a cascade would make a programme report itself more complete when somebody tidies up",
    );
    check(
      "two spellings of one topic are one topic",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes
            where tablename = 'campaign_topics' and indexdef ilike '%lower(title)%'`,
        )
      ).rows[0].n === "1",
    );

    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    const { rows: who } = await c.query<{ id: string }>(
      `select id from "user" order by created_at limit 1`,
    );
    if (org.length === 0 || who.length === 0) {
      console.info("  skip  needs one organisation and one account");
    } else {
      const orgId = org[0].id;
      const userId = who[0].id;
      const { addTopic, createCampaign, getCampaign, linkTopicToDraft, listCampaigns, setCampaignStatus } =
        await import("../src/server/campaigns/run");
      const { skillDrafts } = await import("../src/server/db/schema");
      const { withExplicitOrgScope } = await import("../src/server/dal/scope");

      let campaignId: string | null = null;
      let draftId: string | null = null;

      try {
        const created = await createCampaign({
          orgId,
          userId,
          name: `verify:campaigns probe ${Date.now()}`,
          purpose: "probe",
        });
        check("a campaign is created", created.ok);
        if (!created.ok) throw new Error("cannot continue");
        campaignId = created.data.id;

        const empty = await getCampaign(campaignId, orgId);
        check(
          "an empty campaign reports no share rather than zero per cent",
          empty !== null && capturedShare(empty.progress) === null,
        );

        const t1 = await addTopic({ orgId, campaignId, title: "Incident escalation" });
        const t2 = await addTopic({ orgId, campaignId, title: "Redis failover runbook" });
        check("topics are named", t1.ok && t2.ok);

        const dupe = await addTopic({ orgId, campaignId, title: "incident ESCALATION" });
        check(
          "a topic differing only in case is refused",
          !dupe.ok && dupe.refusal === "duplicate-topic",
          "the folded index decides, not the caller",
        );

        const two = await getCampaign(campaignId, orgId);
        check(
          "progress counts what was asked for",
          two?.progress.topics === 2 && two.progress.published === 0,
          `${two?.progress.topics} topics, ${two?.progress.published} captured`,
        );
        check(
          "and every topic starts not-started",
          two?.topics.every((topic) => topic.state === "not-started") === true,
        );

        draftId = await withExplicitOrgScope(orgId, async (tx) => {
          const [row] = await tx
            .insert(skillDrafts)
            .values({
              orgId,
              name: "verify:campaigns probe draft",
              slug: `verify-campaigns-probe-${Date.now()}`,
              purpose: "probe",
              archetypeCategory: "review",
              status: "ready",
            })
            .returning({ id: skillDrafts.id });
          return row.id;
        });
        if (t1.ok) await linkTopicToDraft({ orgId, topicId: t1.data.id, draftId });

        const linked = await getCampaign(campaignId, orgId);
        check(
          "linking a draft moves the topic to in-progress with no status written anywhere",
          linked?.progress.drafting === 1 && linked.progress.published === 0,
          `${linked?.progress.drafting} drafting`,
        );

        /*
         * The property the whole design rests on: publishing changes the campaign without the
         * campaign being told. A stored counter would still read zero here.
         */
        await c.query(
          `update skill_drafts set published_skill_id = (select id from skills limit 1) where id = $1`,
          [draftId],
        );
        const published = await getCampaign(campaignId, orgId);
        check(
          "publishing the draft moves the campaign, with nothing told to update",
          published?.progress.published === 1 && capturedShare(published.progress) === 50,
          `${capturedShare(published?.progress ?? { topics: 0, drafting: 0, published: 0, interviews: 0, distillRuns: 0, accepted: 0 })}% captured`,
        );

        /*
         * The listing, executed — not merely exported.
         *
         * `/capture` calls `listCampaigns` and this suite did not, so its correlated subqueries
         * were never run: they interpolated `${captureCampaigns.id}`, drizzle dropped the table
         * qualification on a single-table select, and Postgres refused the whole query with
         * *column reference "id" is ambiguous*. The page 500'd on first render while 22 checks
         * stayed green. Same lesson as C5 exporting `pendingScopeVersions` so the suite executes
         * the selector rather than asserting the SQL exists.
         */
        const listed = await listCampaigns(orgId);
        const mine = listed.find((row) => row.id === campaignId);
        check(
          "the listing the page renders actually runs, and counts the same things",
          mine?.topics === 2 && mine?.published === 1,
          `${mine?.topics} topic(s), ${mine?.published} captured — must match getCampaign's 2 and 1`,
        );

        await setCampaignStatus({ orgId, userId, campaignId, status: "closed" });
        const closed = await addTopic({ orgId, campaignId, title: "Something else" });
        check(
          "a closed campaign refuses a new topic rather than quietly reopening",
          !closed.ok && closed.refusal === "closed",
          "closing is a decision somebody made",
        );
      } finally {
        if (campaignId) await c.query(`delete from capture_campaigns where id = $1`, [campaignId]);
        if (draftId) await c.query(`delete from skill_drafts where id = $1`, [draftId]);
        await c.query(
          `delete from events where kind in ('campaign.opened','campaign.closed','campaign.reopened')
             and at > now() - interval '10 minutes'`,
        );
        const { rows: left } = await c.query<{ n: string }>(
          `select (select count(*) from capture_campaigns where name like 'verify:campaigns probe%')
                + (select count(*) from skill_drafts where name = 'verify:campaigns probe draft') as n`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
