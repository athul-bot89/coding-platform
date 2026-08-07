// Bootstrap an admin from the command line.
//
// The admin panel can grant admin to anyone, but only to a caller who is
// already an admin — so a freshly provisioned database has no way in. This is
// that way in. It is also the recovery path if the last admin demotes itself.
//
//   npm run db:make-admin -- someone@company.com

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Usage: npm run db:make-admin -- someone@company.com");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });

  if (existing?.role === "admin") {
    console.log(`${email} is already an admin.`);
    return;
  }

  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { role: "admin" } });
    console.log(`${email} promoted to admin.`);
    return;
  }

  // No account yet. Inserting a User row here would be worse than useless:
  // NextAuth refuses to link a Google login to an existing user that has no
  // Account row, so it would lock this address out instead of admitting it.
  await prisma.adminInvite.upsert({
    where: { email },
    update: {},
    create: { email },
  });
  console.log(`${email} has no account yet — invited. Admin is granted on their first sign-in.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
