"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { regenerateDraftAction } from "@/app/(protected)/build/actions";
import { Button } from "@/components/ui/button";

/**
 * Re-writing a draft from the inputs already stored on it.
 *
 * Deliberately not a form: nothing is re-collected. The author's words live on the draft,
 * so regeneration is one call with the same inputs and a non-zero temperature — which is
 * why the button is honest rather than decorative.
 */
export function DraftActions({ draftId, busy }: { draftId: string; busy: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function regenerate() {
    startTransition(async () => {
      const result = await regenerateDraftAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.data.refused) toast.warning("The assistant declined to write this one.");
      else toast.success("Rewritten.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={regenerate} disabled={isPending || busy}>
        {isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        Write it again
      </Button>
      <span className="text-muted-foreground text-xs">
        Uses the inputs already saved on this draft. One model call.
      </span>
    </div>
  );
}
