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

export const metadata: Metadata = { title: "Create your account" };

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          Your email is the account. We set up your workspace on first sign-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <OtpForm mode="sign-up" />
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-muted-foreground text-sm">
          Already have an account?{" "}
          <Link href="/sign-in" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
