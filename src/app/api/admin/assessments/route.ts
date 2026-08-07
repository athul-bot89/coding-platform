import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { sweepExpiredSessions, sweepExpiredInvitations } from "@/lib/assessment";

export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  // No cron in this deployment — reads are where abandoned tests get finalized.
  await sweepExpiredSessions();
  await sweepExpiredInvitations();

  const assessments = await prisma.assessment.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      problems: true,
      invitations: { include: { session: { select: { state: true } } } },
    },
  });

  return NextResponse.json(
    assessments.map((a) => ({
      id: a.id,
      title: a.title,
      durationMinutes: a.durationMinutes,
      maxViolations: a.maxViolations,
      isActive: a.isActive,
      createdAt: a.createdAt,
      questionCount: a.problems.length,
      totalPoints: a.problems.reduce((s, p) => s + p.points, 0),
      invitedCount: a.invitations.length,
      completedCount: a.invitations.filter(
        (i) => i.session && i.session.state !== "in_progress"
      ).length,
    }))
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { title, instructions, durationMinutes, maxViolations } = await req
    .json()
    .catch(() => ({}));

  if (!title?.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) {
    return NextResponse.json({ error: "Duration must be 1–1440 minutes" }, { status: 400 });
  }

  const violations = Number(maxViolations);
  if (!Number.isFinite(violations) || violations < 0 || violations > 50) {
    return NextResponse.json({ error: "Max violations must be 0–50" }, { status: 400 });
  }

  const assessment = await prisma.assessment.create({
    data: {
      title: title.trim(),
      instructions: instructions?.trim() || null,
      durationMinutes: Math.floor(duration),
      maxViolations: Math.floor(violations),
    },
  });

  return NextResponse.json({ id: assessment.id });
}
