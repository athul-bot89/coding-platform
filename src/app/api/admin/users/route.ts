import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";

/**
 * Accept an address only if it is shaped like one — no spaces, one `@`, a dot
 * in the domain. Google decides whether it is real; this only keeps obvious
 * typos out of the invite table, where a bad row is invisible until the person
 * it was meant for cannot sign in.
 */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const [users, activity, invites] = await Promise.all([
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
    // Invited admins who have not signed in yet. They own no User row, so they
    // would otherwise be invisible — and an admin would keep re-inviting them.
    prisma.adminInvite.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const lastSeenById = new Map(activity.map((a) => [a.userId, a._max.lastSeenAt]));

  return NextResponse.json({
    users: users.map((u) => ({
      ...u,
      lastSeenAt: lastSeenById.get(u.id) ?? null,
    })),
    invites,
  });
}

/**
 * Grant admin by email address.
 *
 * Two cases, deliberately behind one call so the caller does not have to know
 * which applies: an account that already exists is promoted on the spot, and
 * one that does not is parked in AdminInvite until its first sign-in.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });

  if (existing) {
    if (existing.role === "admin") {
      return NextResponse.json({ status: "already-admin", email });
    }
    await prisma.user.update({ where: { id: existing.id }, data: { role: "admin" } });
    return NextResponse.json({ status: "promoted", email });
  }

  // Upsert rather than create: re-inviting the same address is a no-op the
  // admin should not have to think about, not a unique-constraint 500.
  await prisma.adminInvite.upsert({
    where: { email },
    update: {},
    create: { email, invitedBy: guard.userId },
  });
  return NextResponse.json({ status: "invited", email });
}

/** Withdraw a pending invite. Accounts that already exist are demoted via PATCH. */
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const email = normalizeEmail(new URL(req.url).searchParams.get("email"));
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const { count } = await prisma.adminInvite.deleteMany({ where: { email } });
  if (count === 0) {
    return NextResponse.json({ error: "That invite is no longer pending." }, { status: 404 });
  }
  return NextResponse.json({ success: true });
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
