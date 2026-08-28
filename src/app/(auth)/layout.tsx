import Link from "next/link";
import { redirect } from "next/navigation";

import { Wordmark } from "@/components/brand";
import { getSession } from "@/server/dal/session";

/**
 * Public group. Anyone already signed in has no business here, so send them on.
 */
export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4 sm:p-6">
      <Link href="/" className="text-lg">
        <Wordmark />
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
