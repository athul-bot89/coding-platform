import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { generateJoinToken, testUrl, sweepExpiredSessions } from "@/lib/assessment";

export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  // No cron in this deployment — reads are where abandoned tests get finalized.
  await sweepExpiredSessions();

  const assessments = await prisma.assessment.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      problems: true,
      sessions: { select: { state: true } },
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
      joinUrl: testUrl(a.joinToken),
      startedCount: a.sessions.length,
      completedCount: a.sessions.filter((s) => s.state !== "in_progress").length,
    }))
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { title, instructions, durationMinutes, maxViolations } = await req
    .json()
    .catch(() => ({}));

  // Every field is untrusted JSON, so each is type-checked before anything is
  // called on it — `{"title": 123}` has to come back a 400, not a 500 from
  // .trim(). The PATCH handler validates the same way.
  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  if (instructions != null && typeof instructions !== "string") {
    return NextResponse.json({ error: "Instructions must be text" }, { status: 400 });
  }

  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) {
    return NextResponse.json({ error: "Duration must be 1–1440 minutes" }, { status: 400 });
  }

  const violations = Number(maxViolations);
  if (!Number.isFinite(violations) || violations < 0 || violations > 50) {
    return NextResponse.json({ error: "Max violations must be 0–50" }, { status: 400 });
  }

  // The shared link exists from the moment the test does — there is no separate
  // "publish" step to mint it, and nothing downstream has to cope with a test
  // that has no way in.
  const assessment = await prisma.assessment.create({
    data: {
      title: title.trim(),
      instructions: instructions?.trim() || null,
      durationMinutes: Math.floor(duration),
      maxViolations: Math.floor(violations),
      joinToken: generateJoinToken(),
    },
  });

  return NextResponse.json({ id: assessment.id, joinUrl: testUrl(assessment.joinToken) });
}
