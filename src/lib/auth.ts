import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        (session.user as any).id = user.id;
        (session.user as any).role = (user as any).role;
      }
      return session;
    },
  },
  events: {
    /**
     * Redeem a pending admin invite on the account's very first sign-in.
     *
     * NextAuth awaits this before it issues the session, so the promotion is
     * already in place by the time the session callback above reads the role —
     * the new admin lands on an admin panel rather than having to sign out and
     * back in.
     */
    async createUser({ user }) {
      if (!user.email) return;
      const email = user.email.toLowerCase();

      const invite = await prisma.adminInvite.findUnique({ where: { email } });
      if (!invite) return;

      // One transaction so a failure cannot leave the invite consumed without
      // the role granted, which would silently strand the new admin.
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { role: "admin" } }),
        prisma.adminInvite.delete({ where: { email } }),
      ]);
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
};
