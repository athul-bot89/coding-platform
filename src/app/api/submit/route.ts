import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createAttempt } from "@/lib/grading";

// Practice submissions (the un-proctored /test/[slug] flow).
// Proctored submissions go through /api/session/[id]/submit instead.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { problemId, languageId, sourceCode, kind } = await req.json();

  if (!problemId || !languageId || !sourceCode) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const problem = await prisma.problem.findUnique({
    where: { id: problemId },
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
      userId: (session.user as any).id,
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
