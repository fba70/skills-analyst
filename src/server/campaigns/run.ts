import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  MAX_CAMPAIGN_NAME,
  MAX_TOPIC_TITLE,
  MAX_TOPICS,
  topicState,
  type CampaignProgress,
  type CampaignRefusal,
  type CampaignStatus,
  type TopicState,
} from "@/lib/campaigns";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { campaignTopics, captureCampaigns, events, skillDrafts } from "@/server/db/schema";

/**
 * Expertise capture campaigns (Doc 6 RK.8, plan step E7) — Team.
 *
 * The plan says this step has **nothing new underneath it**, and that is literally true of this
 * module: it writes a campaign and a list of topics, and every number it reports is a query over
 * drafts, interview sessions, distill runs and candidates that Interview and Distill already
 * produce. Nothing here captures anything.
 *
 * What it adds is the denominator — see `src/lib/campaigns.ts`.
 */

export type CampaignResult<T> = { ok: true; data: T } | { ok: false; refusal: CampaignRefusal };

export type TopicRow = {
  id: string;
  title: string;
  note: string | null;
  draftId: string | null;
  draftName: string | null;
  publishedSkillId: string | null;
  state: TopicState;
};

export type CampaignDetail = {
  id: string;
  name: string;
  purpose: string | null;
  subjectUserId: string | null;
  subjectName: string | null;
  axis: string | null;
  category: string | null;
  dueOn: string | null;
  status: CampaignStatus;
  topics: TopicRow[];
  progress: CampaignProgress;
};

export async function createCampaign(input: {
  orgId: string;
  userId: string;
  name: string;
  purpose?: string | null;
  subjectUserId?: string | null;
  axis?: string | null;
  category?: string | null;
  dueOn?: string | null;
}): Promise<CampaignResult<{ id: string }>> {
  const name = input.name.trim().slice(0, MAX_CAMPAIGN_NAME);
  if (!name) return { ok: false, refusal: "empty" };

  return withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(captureCampaigns)
      .values({
        orgId: input.orgId,
        name,
        purpose: input.purpose?.trim() || null,
        subjectUserId: input.subjectUserId || null,
        axis: input.axis || null,
        category: input.category || null,
        dueOn: input.dueOn || null,
        createdBy: input.userId,
      })
      .returning({ id: captureCampaigns.id });

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "campaign.opened",
      subjectType: "capture_campaigns",
      subjectId: row.id,
      reason: name,
      payload: { dueOn: input.dueOn ?? null, subjectUserId: input.subjectUserId ?? null },
    });

    return { ok: true as const, data: { id: row.id } };
  });
}

/**
 * Name something that has to be captured.
 *
 * Refused on a closed campaign rather than silently reopening it: closing is a decision somebody
 * made, and quietly undoing it because a topic arrived is the "recorded then ignored" shape this
 * codebase has three sections about.
 */
export async function addTopic(input: {
  orgId: string;
  campaignId: string;
  title: string;
  note?: string | null;
}): Promise<CampaignResult<{ id: string }>> {
  const title = input.title.trim().slice(0, MAX_TOPIC_TITLE);
  if (!title) return { ok: false, refusal: "empty" };

  return withExplicitOrgScope(input.orgId, async (tx) => {
    const [campaign] = await tx
      .select({ status: captureCampaigns.status })
      .from(captureCampaigns)
      .where(eq(captureCampaigns.id, input.campaignId))
      .limit(1);
    if (!campaign) return { ok: false as const, refusal: "not-found" as const };
    if (campaign.status !== "open") return { ok: false as const, refusal: "closed" as const };

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignTopics)
      .where(eq(campaignTopics.campaignId, input.campaignId));
    if (count >= MAX_TOPICS) return { ok: false as const, refusal: "too-many-topics" as const };

    const rows = await tx
      .insert(campaignTopics)
      .values({ orgId: input.orgId, campaignId: input.campaignId, title, note: input.note?.trim() || null })
      /* The folded unique index decides. Two spellings of one topic is one topic. */
      .onConflictDoNothing()
      .returning({ id: campaignTopics.id });

    if (rows.length === 0) return { ok: false as const, refusal: "duplicate-topic" as const };
    return { ok: true as const, data: { id: rows[0].id } };
  });
}

/** Point a topic at the draft somebody started for it. The only link between the two. */
export async function linkTopicToDraft(input: {
  orgId: string;
  topicId: string;
  draftId: string | null;
}): Promise<{ ok: boolean }> {
  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx
      .update(campaignTopics)
      .set({ draftId: input.draftId })
      .where(eq(campaignTopics.id, input.topicId));
  });
  return { ok: true };
}

export async function setCampaignStatus(input: {
  orgId: string;
  userId: string;
  campaignId: string;
  status: CampaignStatus;
}): Promise<{ ok: boolean }> {
  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx
      .update(captureCampaigns)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(captureCampaigns.id, input.campaignId));

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: input.status === "closed" ? "campaign.closed" : "campaign.reopened",
      subjectType: "capture_campaigns",
      subjectId: input.campaignId,
    });
  });
  return { ok: true };
}

/**
 * One campaign, with its progress derived from the work rather than from a counter.
 *
 * Every number below is a query over rows Interview and Distill wrote for their own reasons.
 * There is no `campaign_progress` column and no job that maintains one — a stored count is a
 * second source of truth that drifts the first time somebody publishes a draft without telling
 * the campaign, which is the normal way work actually happens.
 */
export async function getCampaign(
  campaignId: string,
  orgId: string,
): Promise<CampaignDetail | null> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const { rows: header } = await tx.execute<{
      id: string;
      name: string;
      purpose: string | null;
      subject_user_id: string | null;
      subject_name: string | null;
      axis: string | null;
      category: string | null;
      due_on: string | null;
      status: string;
    }>(sql`
      select c.id, c.name, c.purpose, c.subject_user_id, u.name as subject_name,
             c.axis, c.category, c.due_on::text as due_on, c.status
        from capture_campaigns c
        left join "user" u on u.id = c.subject_user_id
       where c.id = ${campaignId}::uuid
       limit 1
    `);
    if (header.length === 0) return null;
    const row = header[0];

    const topicRows = await tx
      .select({
        id: campaignTopics.id,
        title: campaignTopics.title,
        note: campaignTopics.note,
        draftId: campaignTopics.draftId,
        draftName: skillDrafts.name,
        publishedSkillId: skillDrafts.publishedSkillId,
      })
      .from(campaignTopics)
      .leftJoin(skillDrafts, eq(skillDrafts.id, campaignTopics.draftId))
      .where(eq(campaignTopics.campaignId, campaignId))
      .orderBy(asc(campaignTopics.createdAt));

    const topics: TopicRow[] = topicRows.map((topic) => ({
      ...topic,
      state: topicState({ draftId: topic.draftId, publishedSkillId: topic.publishedSkillId }),
    }));

    /*
     * The evidence half: what Interview and Distill actually did against this campaign's drafts.
     *
     * Reported beside the topic counts and never folded into them. *Twelve interview sessions*
     * is a fact about effort; *four of nine topics captured* is a fact about the outcome, and
     * averaging them would produce a number that answers neither — the same reason lift and
     * telemetry are kept separable on an archetype page.
     */
    const { rows: work } = await tx.execute<{
      interviews: number;
      distill_runs: number;
      accepted: number;
    }>(sql`
      with drafts as (
        select draft_id from campaign_topics
         where campaign_id = ${campaignId}::uuid and draft_id is not null
      )
      select
        (select count(*)::int from interview_sessions s where s.draft_id in (select draft_id from drafts)) as interviews,
        (select count(*)::int from distill_runs d where d.draft_id in (select draft_id from drafts)) as distill_runs,
        (select count(*)::int from interview_candidates ic
           left join interview_sessions s on s.id = ic.session_id
           left join distill_runs d on d.id = ic.distill_run_id
          where coalesce(s.draft_id, d.draft_id) in (select draft_id from drafts)
            and ic.decision in ('accepted', 'edited')) as accepted
    `);

    const progress: CampaignProgress = {
      topics: topics.length,
      drafting: topics.filter((topic) => topic.state === "drafting").length,
      published: topics.filter((topic) => topic.state === "published").length,
      interviews: work[0]?.interviews ?? 0,
      distillRuns: work[0]?.distill_runs ?? 0,
      accepted: work[0]?.accepted ?? 0,
    };

    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      subjectUserId: row.subject_user_id,
      subjectName: row.subject_name,
      axis: row.axis,
      category: row.category,
      dueOn: row.due_on,
      status: row.status === "closed" ? "closed" : "open",
      topics,
      progress,
    };
  });
}

/**
 * Every campaign in the workspace, newest first, each with its headline counts.
 *
 * **The table prefixes are spelled out rather than interpolated**, and that is not a style
 * choice. Drizzle drops qualification on a single-table select, so `${captureCampaigns.id}`
 * renders as a bare `"id"` inside the correlated subquery — where `campaign_topics t` also has
 * an `id`, and Postgres refuses the whole query with *column reference "id" is ambiguous*.
 *
 * `latestSignal` in `dal/skills.ts` carries this warning verbatim and ends with the sentence
 * this function then proved: *"It happens to work there because the outer query has joins and
 * is therefore qualified — which is exactly the kind of accident that breaks the moment a join
 * is removed."* Here there was never a join, so it was broken from the first render.
 */
export async function listCampaigns(orgId: string) {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: captureCampaigns.id,
        name: captureCampaigns.name,
        status: captureCampaigns.status,
        dueOn: captureCampaigns.dueOn,
        topics: sql<number>`(
          select count(*)::int from campaign_topics t
           where t.campaign_id = "capture_campaigns"."id"
        )`,
        published: sql<number>`(
          select count(*)::int from campaign_topics t
            join skill_drafts d on d.id = t.draft_id
           where t.campaign_id = "capture_campaigns"."id" and d.published_skill_id is not null
        )`,
      })
      .from(captureCampaigns)
      .where(eq(captureCampaigns.orgId, orgId))
      .orderBy(desc(captureCampaigns.createdAt))
      .limit(50);
    return rows;
  });
}

/** Topics with no draft yet — the list a facilitator works from. */
export async function openTopics(orgId: string, campaignId: string) {
  return withExplicitOrgScope(orgId, async (tx) =>
    tx
      .select({ id: campaignTopics.id, title: campaignTopics.title, note: campaignTopics.note })
      .from(campaignTopics)
      .where(and(eq(campaignTopics.campaignId, campaignId), sql`${campaignTopics.draftId} is null`))
      .orderBy(asc(campaignTopics.createdAt)),
  );
}
