import "server-only";

import type { OtpPurpose } from "./types";

/**
 * The OTP email.
 *
 * Written for mail clients, not browsers: inline styles only, no external CSS, no web
 * fonts, no images.
 *
 * ## There is no plain-text alternative any more, and that is load-bearing
 *
 * There used to be an `otpText` shipped as the `text/plain` part alongside the HTML. The
 * Nylas v3 send endpoint takes a **single** body with an `is_plaintext` flag, so a
 * multipart alternative is not expressible and the function was removed rather than kept
 * as decoration.
 *
 * What that costs is carried here instead: the code must stay **real text in the markup**
 * — letter-spaced digits in a styled element, never an image, never a CSS background —
 * so a client that strips the HTML, or a screen reader walking it, still yields a readable
 * code. Rendering the digits as an image would look better and would make the message
 * unreadable for the people most likely to need the fallback.
 *
 * The code is never placed in the subject line: subjects show in notification previews and
 * sync to devices that may not be the recipient's.
 */

const SUBJECTS: Record<OtpPurpose, string> = {
  "sign-in": "Your Skills Foundry sign-in code",
  "email-verification": "Verify your email for Skills Foundry",
  "forget-password": "Reset your Skills Foundry password",
  "change-email": "Confirm your new email for Skills Foundry",
};

const INTROS: Record<OtpPurpose, string> = {
  "sign-in": "Use this code to sign in to Skills Foundry.",
  "email-verification": "Use this code to verify your email address.",
  "forget-password": "Use this code to reset your password.",
  "change-email": "Use this code to confirm your new email address.",
};

export function otpSubject(purpose: OtpPurpose): string {
  return SUBJECTS[purpose] ?? SUBJECTS["sign-in"];
}

export function otpHtml(code: string, purpose: OtpPurpose, minutes: number): string {
  const intro = INTROS[purpose] ?? INTROS["sign-in"];
  // Letter-spaced digits, large enough to read from a notification without opening.
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f7f9;">
    <div style="display:none;max-height:0;overflow:hidden;">${intro} Code expires in ${minutes} minutes.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
            <tr>
              <td style="padding:28px 28px 8px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="font-size:15px;font-weight:600;color:#111827;letter-spacing:0.12em;text-transform:uppercase;">
                  Skills Foundry
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 0 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#374151;">
                ${intro}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;">
                <div style="background:#f3f4f6;border-radius:10px;padding:18px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#111827;">
                  ${code}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 24px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#6b7280;">
                The code expires in ${minutes} minutes and can be used once.<br />
                If you did not request it, you can ignore this email — nothing has changed.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
