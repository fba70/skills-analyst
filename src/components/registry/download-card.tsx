import Link from "next/link";
import { Download, ExternalLink, FileLock2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ExplainLink } from "@/components/registry/explain";

/**
 * The download control, and — more often — the explanation of why there isn't one
 * (Doc 2 R8.2).
 *
 * Most skills in this corpus cannot be served. Around 96% carry an attribution-required
 * licence and can; the rest are `metadata_only` or `unresolved`, meaning we analysed them
 * in memory, kept the verdict and the hash, and never wrote the text down. A greyed-out
 * button would read as a defect. The licence is the reason, it is a fact about the skill
 * rather than about us, and it is more useful to the reader than the button would be — so
 * the refusal states it and links to the origin instead.
 */

export type DownloadCardProps = {
  slug: string;
  status: string;
  redistribution: string;
  contentStored: boolean;
  licenseSpdx: string | null;
  originUrl: string | null;
  fileCount: number | null;
};

const SERVABLE = new Set(["mirror_allowed", "attribution_required"]);

export function DownloadCard({
  slug,
  status,
  redistribution,
  contentStored,
  licenseSpdx,
  originUrl,
  fileCount,
}: DownloadCardProps) {
  const licensed = SERVABLE.has(redistribution);
  const servable = licensed && contentStored && status === "indexed";

  if (servable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Download</CardTitle>
          <CardDescription>
            The bundle exactly as validated — {fileCount ?? "the"} file
            {fileCount === 1 ? "" : "s"} plus a receipt carrying the content hash and the
            validation report hash. Extracts to <code className="text-xs">{slug}/</code>, so
            it drops into <code className="text-xs">.claude/skills/</code> unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {/*
            A plain link, not a fetch-and-blob: the browser streams the archive straight
            from the route and the filename comes from Content-Disposition.
          */}
          <Button asChild size="sm">
            <a href={`/api/skills/${slug}/download`} download>
              <Download className="size-4" />
              Download bundle
            </a>
          </Button>

          {redistribution === "attribution_required" ? (
            <span className="text-muted-foreground text-xs">
              {licenseSpdx ?? "This licence"} requires attribution — the archive includes
              the notice to keep with it.
            </span>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const reason = !licensed
    ? redistribution === "unresolved"
      ? "The licence could not be resolved, so the content is not redistributed — only its metadata and verdicts are."
      : "The licence does not permit redistribution, so only metadata and verdicts are held."
    : status !== "indexed"
      ? `This skill is ${status}, so its bundle is not served.`
      : "No mirrored copy is available.";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileLock2 className="text-muted-foreground size-4" />
          Not available for download
        </CardTitle>
        <CardDescription>
          {reason}{" "}
          {/*
            The most-asked question on the whole registry lands here: a licence refusal
            reads as a broken feature unless the rule is one click away.
          */}
          <ExplainLink anchor="licences">Why?</ExplainLink>
        </CardDescription>
      </CardHeader>
      {originUrl ? (
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link href={originUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              Get it from the origin
            </Link>
          </Button>
        </CardContent>
      ) : null}
    </Card>
  );
}
