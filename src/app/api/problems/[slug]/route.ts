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

  const problem = await prisma.problem.findUnique({
    where: { slug: params.slug },
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
