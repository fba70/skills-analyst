import "server-only";

/** Shared shapes, in their own module so transports and templates avoid a cycle. */

export type OtpPurpose =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

export type OtpEmail = {
  to: string;
  code: string;
  purpose: OtpPurpose;
  /** How long the code stays valid, for the copy. */
  expiresInMinutes: number;
};

export type MailTransport = {
  name: string;
  sendOtp(mail: OtpEmail): Promise<void>;
};
