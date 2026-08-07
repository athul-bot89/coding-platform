import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, paginationParams } from "@/lib/admin-guard";
import { isAccepted, isFailed, isPending } from "@/lib/judge0-status";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = paginationParams(searchParams);

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
        passed: a.runs.filter((r) => isAccepted(r.statusId)).length,
        failed: a.runs.filter((r) => isFailed(r.statusId)).length,
        pending: a.runs.filter((r) => isPending(r.statusId)).length,
      },
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
