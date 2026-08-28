"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";

/**
 * One form, two steps: ask for the email, then for the code.
 *
 * Sign-in and sign-up are the same request. Better Auth creates the user on the first
 * valid code (`disableSignUp: false`), so the two pages differ only in wording — which
 * is why they share this component instead of copying it.
 */
export function OtpForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setPending(false);

    if (error) {
      toast.error(error.message ?? "Could not send the code. Try again.");
      return;
    }
    setStep("code");
    toast.success(`Code sent to ${email}`);
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const { error } = await authClient.signIn.emailOtp({ email, otp: code });
    setPending(false);

    if (error) {
      toast.error(error.message ?? "That code did not work.");
      setCode("");
      return;
    }
    // Full navigation, so the server components pick up the fresh session cookie.
    router.push("/dashboard");
    router.refresh();
  }

  if (step === "email") {
    return (
      <form onSubmit={requestCode} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending || email.length === 0}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "sign-up" ? "Send my code" : "Send code"}
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          No password. We email a six-digit code that is good for 10 minutes.
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={submitCode} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="code">Code sent to {email}</Label>
        <InputOTP
          id="code"
          maxLength={6}
          value={code}
          onChange={setCode}
          onComplete={(value) => setCode(value)}
          autoFocus
          containerClassName="justify-center"
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </div>
      <Button type="submit" disabled={pending || code.length < 6}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Continue
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          setStep("email");
          setCode("");
        }}
      >
        <ArrowLeft className="size-4" />
        Use a different email
      </Button>
    </form>
  );
}
