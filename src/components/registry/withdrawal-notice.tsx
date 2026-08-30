import { ShieldOff } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Grounds, in the words a reader needs rather than the enum's. */
const GROUNDS: Record<string, string> = {
  copyright: "a copyright claim",
  license_violation: "a licence complaint",
  privacy: "a privacy request",
  trademark: "a trademark claim",
  author_request: "a request from the author",
  other: "a request",
};

/**
 * What a visitor sees where the content used to be (Doc 2 R7.5).
 *
 * The page still resolves, and it should. R8.4 asks that a skill's permalink stay
 * resolvable so a cited verdict stays citable, and a URL that silently 404s tells a reader
 * nothing about whether the skill was dangerous, deleted, or withdrawn — three very
 * different things, one of which is a reason to distrust the registry rather than the skill.
 *
 * What it does **not** say is who asked or what they alleged. Naming the requester turns a
 * compliance record into a pillory and would chill exactly the author requests Doc 1 commits
 * to honouring; quoting the claim would republish an allegation about a third party that we
 * have not adjudicated. Grounds and a date are enough to be honest without either.
 */
export function WithdrawalNotice({
  grounds,
  decidedAt,
  originUrl,
}: {
  grounds: string;
  decidedAt: Date | null;
  originUrl: string | null;
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldOff className="text-destructive size-4" />
          Withdrawn on request
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          This skill&rsquo;s content was withdrawn following {GROUNDS[grounds] ?? "a request"}
          {decidedAt ? (
            <>
              {" "}
              on{" "}
              {decidedAt.toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </>
          ) : null}
          . The mirrored copy has been deleted and it is no longer available for download.
        </p>
        <p className="text-muted-foreground">
          The record stays here so links and citations to it keep resolving. We do not
          publish who made the request or what they alleged.
        </p>
        {originUrl ? (
          <p className="text-muted-foreground">
            Whatever remains upstream is the author&rsquo;s to publish:{" "}
            <a
              href={originUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground underline underline-offset-4"
            >
              {originUrl}
            </a>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
