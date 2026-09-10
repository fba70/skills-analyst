import type { Metadata } from "next";

import { CapturePanel, type CampaignView } from "@/components/builder/capture-panel";
import { Card, CardContent } from "@/components/ui/card";
import { getCampaign, listCampaigns } from "@/server/campaigns/run";
import { listDrafts } from "@/server/builder/drafts";
import { hasEntitlement } from "@/server/dal/entitlements";
import { requireSession } from "@/server/dal/session";

export const metadata: Metadata = { title: "Expertise capture" };

/**
 * Facilitated expertise capture (Doc 6 RK.8, plan step E7) — Team.
 *
 * ## Shown to everyone, gated on the write
 *
 * `hasEntitlement`, not `require`, so a free-tier workspace sees what the programme is rather
 * than a 404 — the same choice the eval panel and the MCP write tool both make. A feature that
 * disappears cannot be understood, let alone bought, and the actions re-check anyway because a
 * server action is a POST endpoint.
 */
export default async function CapturePage() {
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;

  const entitled = orgId ? await hasEntitlement(orgId, "capture-campaigns") : false;
  const [summaries, drafts] = orgId
    ? await Promise.all([listCampaigns(orgId), listDrafts()])
    : [[], []];

  /*
   * The detail per campaign, because the progress is derived and there is no summary row to
   * read it from. Bounded by `listCampaigns`' own limit; a workspace with fifty open capture
   * programmes has a different problem from a slow page.
   */
  const campaigns = (
    await Promise.all(summaries.map((row) => (orgId ? getCampaign(row.id, orgId) : null)))
  ).filter((row): row is NonNullable<typeof row> => row !== null);

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Expertise capture</h1>
        <p className="text-muted-foreground text-sm">
          Organisational memory before it walks out. A programme names what only one person
          knows; Interview and Distill capture it into drafts; this page says whether you are
          finished.
        </p>
      </div>

      {!entitled ? (
        <Card>
          <CardContent className="text-muted-foreground py-6 text-sm">
            Capture programmes are on the Team plan. Interview mode is free and Distill is on Pro
            — both capture the same knowledge; what this adds is the checklist and the deadline.
          </CardContent>
        </Card>
      ) : (
        <CapturePanel
          campaigns={campaigns as CampaignView[]}
          drafts={drafts.map((draft) => ({ id: draft.id, name: draft.name }))}
        />
      )}
    </div>
  );
}
