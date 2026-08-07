import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, paginationParams } from "@/lib/admin-guard";
import { isAccepted, isFailed, isPending } from "@/lib/judge0-status";

const STATES = ["queued", "running", "done", "error"];
const KINDS = ["submit", "run"];

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = paginationParams(searchParams, { defaultLimit: 25, maxLimit: 200 });

  const q = (searchParams.get("q") ?? "").trim();
  const state = searchParams.get("state") ?? "";
  const kind = searchParams.get("kind") ?? "";
  const problemId = searchParams.get("problemId") ?? "";
  const sessionId = searchParams.get("sessionId") ?? "";
  const proctoredOnly = searchParams.get("proctored") === "1";

  const where: Record<string, unknown> = {};
  if (STATES.includes(state)) where.state = state;
  if (KINDS.includes(kind)) where.kind = kind;
  if (problemId) where.problemId = problemId;
  if (sessionId) where.sessionId = sessionId;
  else if (proctoredOnly) where.sessionId = { not: null };
  // SQLite's LIKE is already case-insensitive for ASCII, and Prisma rejects an
  // explicit `mode` on this provider — so `contains` is the whole filter.
  if (q) {
    where.user = { OR: [{ name: { contains: q } }, { email: { contains: q } }] };
  }

  const [attempts, total, problems] = await Promise.all([
    prisma.attempt.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
        problem: { select: { id: true, title: true, slug: true } },
        session: { select: { id: true, assessment: { select: { id: true, title: true } } } },
        runs: { select: { statusId: true } },
      },
    }),
    prisma.attempt.count({ where }),
    // Populates the filter dropdown, so the page needs no second request.
    prisma.problem.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
  ]);

  return NextResponse.json({
    attempts: attempts.map((a) => ({
      id: a.id,
      user: a.user,
      problem: a.problem,
      languageId: a.languageId,
      kind: a.kind,
      state: a.state,
      score: a.score,
      maxScore: a.maxScore,
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
      // Null for practice on the open problem pages; set for work done inside a
      // proctored run, which is what makes the report reachable from here.
      sessionId: a.sessionId,
      assessmentTitle: a.session?.assessment.title ?? null,
      runsSummary: {
        total: a.runs.length,
        passed: a.runs.filter((r) => isAccepted(r.statusId)).length,
        failed: a.runs.filter((r) => isFailed(r.statusId)).length,
        pending: a.runs.filter((r) => isPending(r.statusId)).length,
      },
    })),
    problems,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}
