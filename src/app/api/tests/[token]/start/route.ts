import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Begin a proctored test from the shared link.
 *
 * Idempotent by design: if this account already has a session for this test it
 * is returned as-is rather than restarted, so refreshing or re-opening the link
 * can never buy a candidate a fresh clock.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const auth = await getServerSession(authOptions);
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (auth.user as any).id as string;

  const assessment = await prisma.assessment.findUnique({
    where: { joinToken: params.token },
    include: { problems: true },
  });

  if (!assessment) {
    return NextResponse.json({ error: "Invalid test link" }, { status: 404 });
  }

  // One run per account. Anyone who already sat this test lands here whatever
  // state their session ended in — a link everybody shares makes a second click
  // the normal case, not the exception.
  const existing = await prisma.testSession.findUnique({
    where: { assessmentId_userId: { assessmentId: assessment.id, userId } },
  });

  if (existing) {
    if (existing.state !== "in_progress") {
      return NextResponse.json({ error: "You have already taken this test" }, { status: 409 });
    }
    if (existing.endsAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Your time for this test has expired" }, { status: 409 });
    }
    return NextResponse.json({ sessionId: existing.id, resumed: true });
  }

  if (!assessment.isActive) {
    return NextResponse.json({ error: "This test is no longer available" }, { status: 410 });
  }

  if (assessment.problems.length === 0) {
    return NextResponse.json({ error: "This test has no questions yet" }, { status: 409 });
  }

  const now = Date.now();
  const served = assessment.problems;
  const email = (auth.user.email ?? "").trim().toLowerCase();

  // The snapshot is written in the same transaction as the session. A session
  // that existed without its own problem set would fall back to the assessment's
  // live one, and so be exposed to exactly the mid-test edits it exists to shut out.
  let testSession;
  try {
    testSession = await prisma.$transaction(async (tx) => {
      const created = await tx.testSession.create({
        data: {
          assessmentId: assessment.id,
          userId,
          candidateName: auth.user!.name?.trim() || email.split("@")[0] || "Candidate",
          candidateEmail: email,
          startedAt: new Date(now),
          endsAt: new Date(now + assessment.durationMinutes * 60_000),
          maxScore: served.reduce((s, p) => s + p.points, 0),
        },
      });

      await tx.sessionProblem.createMany({
        data: served.map((ap) => ({
          sessionId: created.id,
          problemId: ap.problemId,
          ordinal: ap.ordinal,
          points: ap.points,
        })),
      });

      return created;
    });
  } catch (err: any) {
    // Two tabs pressing Start at the same instant; the unique constraint decided
    // which one owns the clock. Hand the loser the session that won.
    if (err?.code === "P2002") {
      const winner = await prisma.testSession.findUnique({
        where: { assessmentId_userId: { assessmentId: assessment.id, userId } },
      });
      if (winner) return NextResponse.json({ sessionId: winner.id, resumed: true });
    }
    throw err;
  }

  return NextResponse.json({ sessionId: testSession.id, resumed: false });
}
