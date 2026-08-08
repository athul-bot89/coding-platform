import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * Server-side gate for the un-proctored practice flow.
 *
 * The page below is a client component, so the check it runs on `status` cannot
 * fire until the bundle has loaded — the shell is served either way, and the
 * boundary only ever existed on the API side. Resolving the session here means a
 * caller who is not an admin never reaches the page at all.
 *
 * Admin rather than merely signed-in: candidates sit tests through /t/[token],
 * and practice grades every hidden case, so leaving it open to any Google
 * account hands out a pass/fail oracle on questions that are still in use.
 */
export default async function TestLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session?.user) redirect("/auth/signin");
  if ((session.user as any).role !== "admin") redirect("/");

  return <>{children}</>;
}
