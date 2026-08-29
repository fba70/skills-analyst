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
  matcher: ["/dashboard/:path*", "/account/:path*", "/skills/:path*", "/settings/:path*"],
};
