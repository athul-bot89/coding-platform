import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";

export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const [users, activity] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        _count: { select: { attempts: true, testSessions: true } },
      },
      orderBy: { name: "asc" },
    }),
    // Last heartbeat across all of a user's runs. Grouped rather than joined so
    // the cost does not grow with the number of accounts.
    prisma.testSession.groupBy({
      by: ["userId"],
      _max: { lastSeenAt: true, startedAt: true },
    }),
  ]);

  const lastSeenById = new Map(activity.map((a) => [a.userId, a._max.lastSeenAt]));

  return NextResponse.json(
    users.map((u) => ({
      ...u,
      lastSeenAt: lastSeenById.get(u.id) ?? null,
    }))
  );
}

export async function PATCH(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { userId, role } = await req.json().catch(() => ({}));
  if (typeof userId !== "string" || !userId || !["user", "admin"].includes(role)) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // Prisma turns an update against a missing row into a throw, which would read
  // as a server fault rather than the stale user list it usually is.
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  return NextResponse.json({ success: true });
}
