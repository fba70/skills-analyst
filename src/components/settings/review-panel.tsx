"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";

import { approveRepoAction, rejectRepoAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { HeldRepo } from "@/server/dal/curation";

/**
 * Repositories the pipeline refused to sync on its own.
 *
 * Everything needed to decide is on the card — marker count, stars, and the sample paths
 * that show *where* those markers are. That last one is what separates a genuine skill
 * collection from a benchmark dataset, and it is the reason these are held rather than
 * skipped: `liferay/liferay-portal` has 286 markers and they are real Cursor skills.
 */
export function ReviewPanel({ repos }: { repos: HeldRepo[] }) {
  if (repos.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-10 text-center text-sm">
          Nothing waiting for review.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        {repos.length} repositor{repos.length === 1 ? "y" : "ies"} held by the discovery
        policy. Approving syncs this repository specifically — it does not change the
        threshold for others.
      </p>
      {repos.map((repo) => (
        <RepoCard key={repo.id} repo={repo} />
      ))}
    </div>
  );
}

function RepoCard({ repo }: { repo: HeldRepo }) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);

  function run(label: string, action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setDone(label);
        toast.success(repo.name, { description: result.message });
      } else {
        toast.error(repo.name, { description: result.message });
      }
    });
  }

  return (
    <Card className={done ? "opacity-60" : undefined}>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={repo.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium underline underline-offset-4"
          >
            {repo.name}
          </a>
          <ExternalLink className="text-muted-foreground size-3" />
          <Badge variant="outline" className="text-xs">
            {repo.hitCount} markers
          </Badge>
          {repo.stars !== null ? (
            <span className="text-muted-foreground text-xs">
              ★ {repo.stars.toLocaleString()}
            </span>
          ) : null}
          {done ? (
            <Badge variant="secondary" className="text-xs">
              {done}
            </Badge>
          ) : null}
        </div>

        {repo.reason ? (
          <p className="text-muted-foreground text-sm">{repo.reason}</p>
        ) : null}

        {repo.samplePaths && repo.samplePaths.length > 0 ? (
          <ul className="text-muted-foreground grid gap-0.5 font-mono text-xs">
            {repo.samplePaths.slice(0, 4).map((path) => (
              /* Plain text: these paths come from a third party. */
              <li key={path} className="min-w-0 truncate">
                {path}
              </li>
            ))}
          </ul>
        ) : null}

        {!done ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (required to reject)"
              className="h-9 max-w-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={isPending || reason.trim().length === 0}
              onClick={() => run("rejected", () => rejectRepoAction(repo.id, reason))}
            >
              <X className="size-4" />
              Reject
            </Button>
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => run("approved", () => approveRepoAction(repo.id))}
            >
              <Check className="size-4" />
              Approve
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
