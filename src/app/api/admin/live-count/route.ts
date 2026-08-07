import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { ONLINE_GRACE_MS } from "@/lib/proctor-config";

/**
 * How many candidates are sitting a test right now — nothing else.
 *
 * The admin sidebar polls this from every page, so it is two counts and no
 * sweep: runs whose clock has already run out are excluded by `endsAt` instead,
 * which costs nothing and never reports a walked-away candidate as live.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const now = new Date();
  const fresh = new Date(now.getTime() - ONLINE_GRACE_MS);

  const [live, online] = await Promise.all([
    prisma.testSession.count({ where: { state: "in_progress", endsAt: { gt: now } } }),
    prisma.testSession.count({
      where: { state: "in_progress", endsAt: { gt: now }, lastSeenAt: { gte: fresh } },
    }),
  ]);

  return NextResponse.json({ live, online });
}
