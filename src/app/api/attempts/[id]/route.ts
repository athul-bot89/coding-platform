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
  // what they submitted. Practice attempts (no sessionId) are admin-only, in
  // step with /api/submit: any a non-admin still owns predate that rule, and
  // reading one back is the same hidden-case oracle by a slower route.
  if (!isAdmin && !attempt.sessionId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const graded = await pollAndScoreAttempt(params.id);
  return NextResponse.json(formatAttemptResponse(graded, isAdmin));
}
