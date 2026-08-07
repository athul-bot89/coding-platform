import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailsMatch } from "@/lib/assessment";

/**
 * Begin a proctored test.
 *
 * Idempotent by design: if a session already exists for this invitation it is
 * returned as-is rather than restarted, so refreshing or re-opening the link can
 * never buy a candidate a fresh clock.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invitation = await prisma.invitation.findUnique({
    where: { token: params.token },
    include: {
      assessment: { include: { problems: true } },
      session: true,
    },
  });

  if (!invitation) {
    return NextResponse.json({ error: "Invalid invite link" }, { status: 404 });
  }

  // Re-check the email server-side. The page already gates on this, but the page
  // is not the authority.
  if (!emailsMatch(session.user.email, invitation.candidateEmail)) {
    return NextResponse.json(
      { error: `This link belongs to ${invitation.candidateEmail}` },
      { status: 403 }
    );
  }

  if (invitation.session) {
    if (invitation.session.state !== "in_progress") {
      return NextResponse.json({ error: "This test has already been completed" }, { status: 409 });
    }
    if (invitation.session.endsAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Your time for this test has expired" }, { status: 409 });
    }
    return NextResponse.json({ sessionId: invitation.session.id, resumed: true });
  }

  // One run of an assessment per candidate. Invitations are unique per
  // (assessment, email), but a link minted before that constraint existed could
  // still hand a candidate who has already sat the test a second fresh clock.
  const priorRun = await prisma.testSession.findFirst({
    where: {
      userId: (session.user as any).id,
      invitation: { assessmentId: invitation.assessmentId },
    },
    select: { id: true },
  });
  if (priorRun) {
    return NextResponse.json({ error: "You have already taken this test" }, { status: 409 });
  }

  if (invitation.expiresAt.getTime() < Date.now()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "expired" },
    });
    return NextResponse.json({ error: "This invite link has expired" }, { status: 410 });
  }

  if (!invitation.assessment.isActive) {
    return NextResponse.json({ error: "This test is no longer available" }, { status: 410 });
  }

  if (invitation.assessment.problems.length === 0) {
    return NextResponse.json({ error: "This test has no questions yet" }, { status: 409 });
  }

  const now = Date.now();
  const served = invitation.assessment.problems;

  // The snapshot is written in the same transaction as the session. A session
  // that existed without its own problem set would fall back to the assessment's
  // live one, and so be exposed to exactly the mid-test edits it exists to shut out.
  const testSession = await prisma.$transaction(async (tx) => {
    const created = await tx.testSession.create({
      data: {
        invitationId: invitation.id,
        userId: (session.user as any).id,
        startedAt: new Date(now),
        endsAt: new Date(now + invitation.assessment.durationMinutes * 60_000),
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

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "started" },
    });

    return created;
  });

  return NextResponse.json({ sessionId: testSession.id, resumed: false });
}
