import type { Metadata } from "next";
import Link from "next/link";

import { OtpForm } from "@/components/auth/otp-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Enter your email and we send you a code.</CardDescription>
      </CardHeader>
      <CardContent>
        <OtpForm mode="sign-in" />
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-muted-foreground text-sm">
          New here?{" "}
          <Link href="/sign-up" className="text-foreground underline underline-offset-4">
            Create an account
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
