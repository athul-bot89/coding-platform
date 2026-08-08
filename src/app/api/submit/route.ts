import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAttempt } from "@/lib/grading";
import { requireAdmin } from "@/lib/admin-guard";

// Practice submissions (the un-proctored /test/[slug] flow).
// Proctored submissions go through /api/session/[id]/submit instead.
export async function POST(req: NextRequest) {
  // This endpoint grades every hidden case and reports pass/fail on each one, so
  // it is an oracle on any question that is still in use. The in-progress check
  // below only ever closed that window during a test; a candidate who practised
  // the day before got the same answers with nothing in the way. Practice is an
  // admin surface for that reason — candidates are graded through /t/[token].
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const userId = auth.userId;

  // Still enforced for an admin sitting a test of their own: while any session is
  // in progress the only legal grading path is the session one.
  const liveSessions = await prisma.testSession.count({
    where: { userId, state: "in_progress" },
  });
  if (liveSessions > 0) {
    return NextResponse.json(
      { error: "You have an assessment in progress — submit it before practising" },
      { status: 409 }
    );
  }

  const { problemId, languageId, sourceCode, kind } = await req.json().catch(() => ({}));

  if (typeof problemId !== "string" || !problemId || typeof sourceCode !== "string") {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (typeof languageId !== "number" || !Number.isInteger(languageId)) {
    return NextResponse.json({ error: "Invalid language" }, { status: 400 });
  }
  if (!sourceCode.trim()) {
    return NextResponse.json({ error: "Write some code first" }, { status: 400 });
  }

  // A retired problem reads as gone here: its test cases may no longer match the
  // statement anyone can still see.
  const problem = await prisma.problem.findFirst({
    where: { id: problemId, isActive: true },
    include: { testCases: { orderBy: { ordinal: "asc" } } },
  });

  if (!problem) {
    return NextResponse.json({ error: "Problem not found" }, { status: 404 });
  }

  const allowedLangs = problem.allowedLanguages.split(",").map(Number);
  if (!allowedLangs.includes(languageId)) {
    return NextResponse.json({ error: "Language not allowed" }, { status: 400 });
  }

  try {
    const attemptId = await createAttempt({
      userId,
      problem,
      languageId,
      sourceCode,
      kind: kind === "run" ? "run" : "submit",
    });
    return NextResponse.json({ attemptId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
