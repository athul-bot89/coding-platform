import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  // Admin-only, exactly like the problem list this backs. Being signed in is not
  // a meaningful boundary here — sign-in is open to any Google account — so a
  // merely-authenticated check left the full statement, the samples and the
  // starter code readable by anyone who knew or guessed a slug.
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  // Retained for an admin who is also sitting a test: while a session is live
  // the session page is the only surface, so practice cannot be used to read
  // ahead. Outside one the un-proctored editor is a scratchpad where nothing is
  // recorded and nothing is measured.
  const liveSessions = await prisma.testSession.count({
    where: { userId: auth.userId, state: "in_progress" },
  });
  if (liveSessions > 0) {
    return NextResponse.json(
      { error: "You have an assessment in progress — finish it to practise" },
      { status: 409 }
    );
  }

  // Retired problems are not served: the statement and its sample cases stop
  // being something the platform stands behind once isActive is off.
  const problem = await prisma.problem.findFirst({
    where: { slug: params.slug, isActive: true },
    include: {
      testCases: {
        where: { kind: "sample" },
        orderBy: { ordinal: "asc" },
      },
    },
  });

  if (!problem) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: problem.id,
    title: problem.title,
    slug: problem.slug,
    description: problem.description,
    difficulty: problem.difficulty,
    allowedLanguages: problem.allowedLanguages,
    timeLimitMs: problem.timeLimitMs,
    memoryLimitKb: problem.memoryLimitKb,
    starterCode: problem.starterCode ? JSON.parse(problem.starterCode) : {},
    sampleTestCases: problem.testCases.map((tc) => ({
      ordinal: tc.ordinal,
      stdin: tc.stdin,
      expectedOutput: tc.expectedOutput,
    })),
  });
}
