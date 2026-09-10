"use server";

import { revalidatePath } from "next/cache";

/**
 * Watching, as a server action (Doc 2 R8.7, plan step F5).
 *
 * At the group root rather than under one route, because the button appears on a public skill
 * page and the feed on the dashboard — two segments, one action. A server action *is* a POST
 * endpoint, so the session is resolved here and never taken from the caller.
 */
export type WatchResult = { ok: boolean; message: string };

export async function setWatchAction(
  subjectType: string,
  subjectId: string,
  on: boolean,
): Promise<WatchResult> {
  try {
    const { requireSession } = await import("@/server/dal/session");
    const session = await requireSession();
    const { watch, unwatch } = await import("@/server/notifications/watch");

    const outcome = on
      ? await watch({ userId: session.user.id, subjectType, subjectId })
      : await unwatch({ userId: session.user.id, subjectType, subjectId });

    revalidatePath("/dashboard");
    return outcome;
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}

/** Move the watermark on every watch. One column, so "read everything" is one write. */
export async function markSeenAction(): Promise<WatchResult> {
  try {
    const { requireSession } = await import("@/server/dal/session");
    const session = await requireSession();
    const { markSeen } = await import("@/server/notifications/watch");
    await markSeen(session.user.id);
    revalidatePath("/dashboard");
    return { ok: true, message: "Caught up." };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 200) };
  }
}
