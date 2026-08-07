import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { pollAndScoreAttempt, formatAttemptResponse } from "@/lib/grading";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as any).id;
  const isAdmin = (session.user as any).role === "admin";

  const attempt = await prisma.attempt.findUnique({
    where: { id: params.id },
    select: { id: true, userId: true, sessionId: true },
  });

  if (!attempt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (attempt.userId !== userId && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Proctored attempts stay readable here — this is the route the session UI
  // polls for its own results, and a candidate is entitled to the verdicts on
  // what they submitted. Practice attempts are the ones to close off: one queued
  // before the test began would otherwise keep answering hidden-case questions
  // mid-exam, which is exactly the oracle /api/submit refuses to open.
  if (!isAdmin && !attempt.sessionId) {
    const liveSessions = await prisma.testSession.count({
      where: { userId, state: "in_progress" },
    });
    if (liveSessions > 0) {
      return NextResponse.json(
        { error: "Practice results are unavailable while an assessment is in progress" },
        { status: 409 }
      );
    }
  }

  const graded = await pollAndScoreAttempt(params.id);
  return NextResponse.json(formatAttemptResponse(graded, isAdmin));
}
