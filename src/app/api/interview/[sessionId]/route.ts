import { after } from "next/server";

import { ConversationBudgetError } from "@/server/billing/conversation";
import { requireSession } from "@/server/dal/session";
import { endForBudget, takeTurn } from "@/server/interview/turn";

/**
 * One interview turn, streamed (Doc 6 RW.4, plan step C2b).
 *
 * ## Why a route handler, when queries live in `src/server/**`
 *
 * The rule is that route handlers get no database and that anything returning a value to our
 * own bundle is a server action. Both hold here, and this is the third documented exception
 * for the same reason as the first two: **a server action returns a serialisable value, and
 * this returns a stream.** The download route could not be an action because a file is not a
 * value; the MCP endpoint could not because a wire protocol is not a value; newline-delimited
 * JSON arriving over twenty seconds is not a value either.
 *
 * The file imports no database module, no query builder and no driver. Every read and write
 * lives in `src/server/interview/**`, where the DAL scopes it to the caller's organisation.
 *
 * ## NDJSON, not SSE
 *
 * The client is our own `fetch`, not an `EventSource`, so SSE's framing buys nothing and costs
 * a parser. One JSON object per line is what the partial-output stream already produces, and a
 * reader that finds a truncated last line knows the stream was cut — which is more than SSE's
 * silent close tells you.
 *
 * ## The session is re-resolved here
 *
 * A route handler is as reachable as a server action is. The page guard controls who sees the
 * interview; this controls who can spend money in one.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return Response.json({ error: "No active workspace." }, { status: 400 });

  const { sessionId } = await params;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  const authorText = typeof body.text === "string" ? body.text.slice(0, 20_000) : "";

  let turn: Awaited<ReturnType<typeof takeTurn>>;
  try {
    turn = await takeTurn({ sessionId, orgId, authorText });
  } catch (error) {
    /*
     * A budget refusal is a 402 with the state attached, not a 500.
     *
     * The distinction matters for the same reason the rate limiter's 429 does: a client that
     * cannot tell "you are out of money" from "something broke" either retries a hard failure
     * forever or gives up on a soft one. The session is ended here too, so the reason it
     * stopped is on the row rather than inferred from a gap in the transcript.
     */
    if (error instanceof ConversationBudgetError) {
      await endForBudget(sessionId, orgId, error.block);
      return Response.json(
        { error: error.message, block: error.block, budget: error.budget },
        { status: 402 },
      );
    }
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      try {
        for await (const partial of turn.partialStream) {
          send({ type: "partial", value: partial });
        }
        const done = await turn.done;
        send({ type: "done", ...done });
      } catch (error) {
        send({ type: "error", message: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  /*
   * `after` keeps the invocation alive for the persistence and the ledger write even when the
   * client has gone.
   *
   * The seam already guarantees its promises resolve without a reader — it drains the model
   * stream itself. What it cannot do from inside is stop the platform tearing the invocation
   * down the moment the response finishes, and a turn whose tokens were generated but whose
   * ledger row never landed is invisible under-billing, which is the failure this whole step
   * exists to prevent.
   */
  after(async () => {
    await turn.done.catch(() => undefined);
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      /* Proxies that buffer would defeat the point of streaming at all. */
      "x-accel-buffering": "no",
    },
  });
}
