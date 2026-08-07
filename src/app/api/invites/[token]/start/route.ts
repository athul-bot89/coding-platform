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
  const testSession = await prisma.testSession.create({
    data: {
      invitationId: invitation.id,
      userId: (session.user as any).id,
      startedAt: new Date(now),
      endsAt: new Date(now + invitation.assessment.durationMinutes * 60_000),
      maxScore: invitation.assessment.problems.reduce((s, p) => s + p.points, 0),
    },
  });

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: "started" },
  });

  return NextResponse.json({ sessionId: testSession.id, resumed: false });
}
