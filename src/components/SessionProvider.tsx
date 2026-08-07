"use client";

import { SessionProvider as NextAuthProvider } from "next-auth/react";

export function SessionProvider({
  children,
  session,
}: {
  children: React.ReactNode;
  session: any;
}) {
  return <NextAuthProvider session={session}>{children}</NextAuthProvider>;
}
