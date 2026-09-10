import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 renamed `middleware` to `proxy`. Same job, node runtime only.
 *
 * This is an optimisation, not a security boundary: it checks that a session cookie is
 * *present*, which is cheap and enough to send a signed-out visitor to /sign-in without
 * rendering a page first. It does not validate the cookie. The real check is
 * `requireSession()` in every protected server component and server action —
 * specs/core/03-implementation-spec.md is explicit that a matcher can be escaped.
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = Boolean(getSessionCookie(request));
  if (hasSessionCookie) {
    return NextResponse.next();
  }

  const signIn = new URL("/sign-in", request.url);
  return NextResponse.redirect(signIn);
}

export const config = {
  // `/skills`, `/archetypes`, `/faq` and `/submit` are deliberately absent: all four are
  // public (R8.1, and Doc 1 licenses archetype snapshots CC BY-SA). Adding any of them back
  // would redirect anonymous visitors away from the pages that exist to be read by anyone —
  // and the FAQ is what makes the other two legible.
  //
  // `/submit` is R1.8's public half, so gating it would defeat the requirement outright: the
  // people who know which repositories we have missed are mostly people without an account.
  matcher: [
    "/dashboard/:path*",
    "/account/:path*",
    "/settings/:path*",
    // Drafts belong to an organisation, so unlike the registry this one is gated.
    "/build/:path*",
    // RK.8's capture programmes. Team-gated in the page and in every action.
    "/capture/:path*",
    // RK.6's curation desk. The page itself `notFound()`s for anybody without standing; this
    // only saves an anonymous visitor a round trip, like every other entry here.
    "/curate/:path*",
  ],
};
