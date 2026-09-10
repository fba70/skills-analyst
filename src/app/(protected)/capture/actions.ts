"use server";

import { revalidatePath } from "next/cache";

import { CAMPAIGN_REFUSAL_MESSAGE } from "@/lib/campaigns";

/**
 * Capture-campaign actions (Doc 6 RK.8, plan step E7) — Team.
 *
 * One gate for all of them, resolved here rather than in the page: a server action is a POST
 * endpoint, so the page guard protects the view and this protects the operation.
 */
export type CaptureResult = { ok: boolean; message: string };

async function gate(): Promise<
  { ok: true; orgId: string; userId: string } | { ok: false; message: string }
> {
  const { requireSession } = await import("@/server/dal/session");
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { ok: false, message: "No active workspace." };
  const { requireEntitlement } = await import("@/server/dal/entitlements");
  await requireEntitlement(orgId, "capture-campaigns");
  return { ok: true, orgId, userId: session.user.id };
}

export async function createCampaignAction(
  name: string,
  purpose: string,
  dueOn: string,
): Promise<CaptureResult> {
  try {
    const g = await gate();
    if (!g.ok) return g;
    const { createCampaign } = await import("@/server/campaigns/run");
    const outcome = await createCampaign({
      orgId: g.orgId,
      userId: g.userId,
      name,
      purpose,
      dueOn: dueOn || null,
    });
    if (!outcome.ok) return { ok: false, message: CAMPAIGN_REFUSAL_MESSAGE[outcome.refusal] };
    revalidatePath("/capture");
    return { ok: true, message: "Campaign opened. Name what has to be captured." };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}

export async function addTopicAction(
  campaignId: string,
  title: string,
  note: string,
): Promise<CaptureResult> {
  try {
    const g = await gate();
    if (!g.ok) return g;
    const { addTopic } = await import("@/server/campaigns/run");
    const outcome = await addTopic({ orgId: g.orgId, campaignId, title, note });
    if (!outcome.ok) return { ok: false, message: CAMPAIGN_REFUSAL_MESSAGE[outcome.refusal] };
    revalidatePath("/capture");
    return { ok: true, message: "Added." };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}

/** Point a topic at the draft somebody started for it, or unlink it. */
export async function linkTopicAction(
  topicId: string,
  draftId: string | null,
): Promise<CaptureResult> {
  try {
    const g = await gate();
    if (!g.ok) return g;
    const { linkTopicToDraft } = await import("@/server/campaigns/run");
    await linkTopicToDraft({ orgId: g.orgId, topicId, draftId });
    revalidatePath("/capture");
    return { ok: true, message: draftId ? "Linked." : "Unlinked." };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}

export async function setCampaignStatusAction(
  campaignId: string,
  status: string,
): Promise<CaptureResult> {
  try {
    const g = await gate();
    if (!g.ok) return g;
    const { isCampaignStatus } = await import("@/lib/campaigns");
    if (!isCampaignStatus(status)) return { ok: false, message: "Unknown status." };
    const { setCampaignStatus } = await import("@/server/campaigns/run");
    await setCampaignStatus({ orgId: g.orgId, userId: g.userId, campaignId, status });
    revalidatePath("/capture");
    return { ok: true, message: status === "closed" ? "Closed." : "Reopened." };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}
