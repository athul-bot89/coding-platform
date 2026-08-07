import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { inviteUrl, sweepExpiredSessions, sweepExpiredInvitations } from "@/lib/assessment";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  await sweepExpiredSessions();
  await sweepExpiredInvitations();

  const assessment = await prisma.assessment.findUnique({
    where: { id: params.id },
    include: {
      problems: { include: { problem: true }, orderBy: { ordinal: "asc" } },
      invitations: {
        orderBy: { createdAt: "desc" },
        include: { session: true },
      },
    },
  });

  if (!assessment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const allProblems = await prisma.problem.findMany({
    where: { isActive: true },
    select: { id: true, title: true, slug: true, difficulty: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    id: assessment.id,
    title: assessment.title,
    instructions: assessment.instructions,
    durationMinutes: assessment.durationMinutes,
    maxViolations: assessment.maxViolations,
    isActive: assessment.isActive,
    problems: assessment.problems.map((ap) => ({
      problemId: ap.problemId,
      ordinal: ap.ordinal,
      points: ap.points,
      title: ap.problem.title,
      difficulty: ap.problem.difficulty,
    })),
    availableProblems: allProblems,
    invitations: assessment.invitations.map((i) => ({
      id: i.id,
      candidateName: i.candidateName,
      candidateEmail: i.candidateEmail,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      url: inviteUrl(i.token),
      sessionId: i.session?.id ?? null,
      sessionState: i.session?.state ?? null,
      score: i.session && i.session.state !== "in_progress" ? i.session.totalScore : null,
      maxScore: i.session?.maxScore ?? null,
      violationCount: i.session?.violationCount ?? null,
    })),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const body = await req.json().catch(() => ({}));
  const data: any = {};

  if (typeof body.title === "string") {
    if (!body.title.trim()) {
      return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    }
    data.title = body.title.trim();
  }
  if (typeof body.instructions === "string") data.instructions = body.instructions.trim() || null;
  if (body.durationMinutes !== undefined) {
    const d = Number(body.durationMinutes);
    if (!Number.isFinite(d) || d < 1 || d > 1440) {
      return NextResponse.json({ error: "Duration must be 1–1440 minutes" }, { status: 400 });
    }
    data.durationMinutes = Math.floor(d);
  }
  if (body.maxViolations !== undefined) {
    const v = Number(body.maxViolations);
    if (!Number.isFinite(v) || v < 0 || v > 50) {
      return NextResponse.json({ error: "Max violations must be 0–50" }, { status: 400 });
    }
    data.maxViolations = Math.floor(v);
  }
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

  // Replacing the problem set only affects tests started afterwards; sessions
  // already in flight keep the questions they were served.
  if (Array.isArray(body.problems)) {
    const entries = body.problems
      .map((p: any, i: number) => ({
        problemId: String(p.problemId),
        ordinal: i + 1,
        points: Math.max(1, Math.min(10_000, Math.floor(Number(p.points) || 100))),
      }))
      .filter((p: any) => p.problemId);

    const unique = new Map(entries.map((e: any) => [e.problemId, e]));

    await prisma.$transaction([
      prisma.assessmentProblem.deleteMany({ where: { assessmentId: params.id } }),
      prisma.assessmentProblem.createMany({
        data: Array.from(unique.values()).map((e: any) => ({ ...e, assessmentId: params.id })),
      }),
    ]);
  }

  if (Object.keys(data).length > 0) {
    await prisma.assessment.update({ where: { id: params.id }, data });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  await prisma.assessment.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
