import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Nothing outside the test is served while a test is running: the practice
  // flow is an un-proctored editor on the same problem bank, which is no place
  // for a candidate to be halfway through an assessment.
  const liveSessions = await prisma.testSession.count({
    where: { userId: (session.user as any).id, state: "in_progress" },
  });
  if (liveSessions > 0) {
    return NextResponse.json(
      { error: "You have an assessment in progress — finish it to browse problems" },
      { status: 409 }
    );
  }

  const problems = await prisma.problem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      title: true,
      slug: true,
      difficulty: true,
      allowedLanguages: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(problems);
}
