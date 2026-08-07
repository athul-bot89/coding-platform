import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Same rule as the problem list: during a proctored test the session page is
  // the only surface a candidate gets. Otherwise the un-proctored editor doubles
  // as a scratchpad where nothing is recorded and nothing is measured.
  const liveSessions = await prisma.testSession.count({
    where: { userId: (session.user as any).id, state: "in_progress" },
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
