import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user || (session.user as any).role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const skip = (page - 1) * limit;

  const [attempts, total] = await Promise.all([
    prisma.attempt.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
        problem: { select: { title: true, slug: true } },
        runs: { include: { testCase: { select: { ordinal: true, kind: true } } } },
      },
    }),
    prisma.attempt.count(),
  ]);

  return NextResponse.json({
    attempts: attempts.map((a) => ({
      id: a.id,
      user: a.user,
      problem: a.problem,
      languageId: a.languageId,
      state: a.state,
      score: a.score,
      maxScore: a.maxScore,
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
      runsSummary: {
        total: a.runs.length,
        passed: a.runs.filter((r) => r.statusId === 3).length,
        failed: a.runs.filter((r) => r.statusId && r.statusId > 3).length,
        pending: a.runs.filter((r) => !r.statusId || r.statusId <= 2).length,
      },
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
