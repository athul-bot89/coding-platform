import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { paginationParams, requireAdmin } from "@/lib/admin-guard";
import { sessionElapsedMs, summarizeSessions, sweepExpiredSessions } from "@/lib/assessment";

const STATES = ["in_progress", "submitted", "auto_submitted", "terminated"];

/**
 * Ordering the database can do. Score uses the frozen `totalScore` column, which
 * is only written at finalization — so it ranks completed runs, and anyone still
 * working sorts to the bottom on a zero they have not actually earned. The rows
 * themselves always show the recomputed running total, and the UI says as much.
 */
function orderFor(sort: string | null) {
  switch (sort) {
    case "oldest":
      return [{ startedAt: "asc" as const }];
    case "warnings":
      return [{ violationCount: "desc" as const }, { startedAt: "desc" as const }];
    case "score":
      return [{ totalScore: "desc" as const }, { startedAt: "desc" as const }];
    default:
      return [{ startedAt: "desc" as const }];
  }
}

/**
 * Every candidate run across every test — the view the per-test leaderboard
 * cannot give you.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  await sweepExpiredSessions();

  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = paginationParams(searchParams, {
    defaultLimit: 25,
    maxLimit: 200,
  });

  const q = (searchParams.get("q") ?? "").trim();
  const assessmentId = searchParams.get("assessmentId") ?? "";
  const state = searchParams.get("state") ?? "";
  const flagged = searchParams.get("flagged") === "1";
  const sort = searchParams.get("sort");

  const where: Record<string, unknown> = {};
  if (assessmentId) where.assessmentId = assessmentId;
  if (state === "live") where.state = "in_progress";
  else if (state === "finished") where.state = { not: "in_progress" };
  else if (STATES.includes(state)) where.state = state;
  if (flagged) where.violationCount = { gt: 0 };
  // SQLite's LIKE is already case-insensitive for ASCII, and Prisma rejects an
  // explicit `mode` on this provider — so `contains` is the whole filter.
  if (q) {
    where.OR = [{ candidateName: { contains: q } }, { candidateEmail: { contains: q } }];
  }

  const [rows, total, assessments] = await Promise.all([
    prisma.testSession.findMany({
      where,
      skip,
      take: limit,
      orderBy: orderFor(sort),
      include: {
        assessment: { select: { id: true, title: true, maxViolations: true } },
        user: { select: { image: true, email: true } },
      },
    }),
    prisma.testSession.count({ where }),
    // Populates the filter dropdown, so the page needs no second request.
    prisma.assessment.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true },
    }),
  ]);

  const summaries = await summarizeSessions(
    rows.map((s) => ({ id: s.id, assessmentId: s.assessmentId }))
  );

  const now = Date.now();

  return NextResponse.json({
    // Sent so the browser can run "time left" off the server's clock rather than
    // its own, which may be minutes out.
    serverNow: now,
    sessions: rows.map((s) => {
      const sum = summaries.get(s.id)!;
      return {
        sessionId: s.id,
        candidateName: s.candidateName,
        candidateEmail: s.candidateEmail,
        image: s.user?.image ?? null,
        // Differs from candidateEmail when the Google account was renamed after
        // the test was taken.
        signedInAs: s.user?.email ?? null,
        assessmentId: s.assessmentId,
        assessmentTitle: s.assessment.title,
        maxViolations: s.assessment.maxViolations,
        state: s.state,
        live: s.state === "in_progress",
        totalScore: sum.totalScore,
        maxScore: sum.maxScore,
        solvedCount: sum.solvedCount,
        questionCount: sum.questionCount,
        submissionCount: sum.submissionCount,
        violationCount: s.violationCount,
        startedAt: s.startedAt,
        submittedAt: s.submittedAt,
        endsAt: s.endsAt,
        lastSeenAt: s.lastSeenAt,
        idleMs: Math.max(0, now - s.lastSeenAt.getTime()),
        elapsedMs: sessionElapsedMs(s, now),
      };
    }),
    assessments,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}
