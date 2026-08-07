import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import {
  sessionElapsedMs,
  summarizeSessions,
  sweepExpiredSessions,
  testUrl,
} from "@/lib/assessment";
import { ONLINE_GRACE_MS } from "@/lib/proctor-config";

/** Rows carried by each feed on the dashboard. */
const FEED_LIMIT = 12;

/**
 * Ceiling on the live panel. A screening test never has this many people in it
 * at once, and the panel is meant to be watched — past this it stops being one.
 */
const LIVE_LIMIT = 60;

/**
 * Everything the admin dashboard shows, in one round trip.
 *
 * Scores for live candidates are recomputed here rather than read from
 * `TestSession.totalScore`, which is only written at finalization — a running
 * total is the whole point of a live monitor.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  // No cron in this deployment — reads are where abandoned tests get finalized.
  // It runs before anything below is counted, so the monitor never shows someone
  // as live whose clock ran out while nobody was looking.
  await sweepExpiredSessions();

  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [
    assessments,
    liveRows,
    recentRows,
    eventRows,
    problemsTotal,
    problemsActive,
    candidateCount,
    submissionsToday,
    sessionsToday,
    flaggedTotal,
  ] = await Promise.all([
    prisma.assessment.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        problems: { select: { points: true } },
        sessions: {
          select: {
            state: true,
            totalScore: true,
            maxScore: true,
            startedAt: true,
            violationCount: true,
          },
        },
      },
    }),
    prisma.testSession.findMany({
      where: { state: "in_progress" },
      // Whoever runs out of time first is who an invigilator needs to see first.
      orderBy: { endsAt: "asc" },
      take: LIVE_LIMIT,
      include: {
        assessment: { select: { id: true, title: true, maxViolations: true } },
        user: { select: { image: true } },
      },
    }),
    prisma.testSession.findMany({
      where: { state: { not: "in_progress" } },
      orderBy: { submittedAt: "desc" },
      take: FEED_LIMIT,
      include: { assessment: { select: { id: true, title: true } } },
    }),
    prisma.proctorEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: FEED_LIMIT,
      include: {
        session: {
          select: {
            id: true,
            candidateName: true,
            assessment: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.problem.count(),
    prisma.problem.count({ where: { isActive: true } }),
    prisma.user.count({ where: { testSessions: { some: {} } } }),
    prisma.attempt.count({ where: { kind: "submit", createdAt: { gte: dayStart } } }),
    prisma.testSession.count({ where: { startedAt: { gte: dayStart } } }),
    prisma.testSession.count({ where: { violationCount: { gt: 0 } } }),
  ]);

  const liveSummaries = await summarizeSessions(
    liveRows.map((s) => ({ id: s.id, assessmentId: s.assessmentId }))
  );

  const tests = assessments.map((a) => {
    const finished = a.sessions.filter((s) => s.state !== "in_progress");
    const scored = finished.filter((s) => s.maxScore > 0);
    return {
      id: a.id,
      title: a.title,
      isActive: a.isActive,
      durationMinutes: a.durationMinutes,
      maxViolations: a.maxViolations,
      createdAt: a.createdAt,
      joinUrl: testUrl(a.joinToken),
      questionCount: a.problems.length,
      totalPoints: a.problems.reduce((s, p) => s + p.points, 0),
      startedCount: a.sessions.length,
      inProgressCount: a.sessions.length - finished.length,
      completedCount: finished.length,
      flaggedCount: a.sessions.filter((s) => s.violationCount > 0).length,
      // Finished runs only. Someone still mid-test has no final score yet, and
      // averaging their zero in would drag every open test's number down.
      avgScorePct: scored.length
        ? Math.round(
            scored.reduce((s, r) => s + (r.totalScore / r.maxScore) * 100, 0) / scored.length
          )
        : null,
      lastStartedAt: a.sessions.reduce<Date | null>(
        (max, s) => (!max || s.startedAt > max ? s.startedAt : max),
        null
      ),
    };
  });

  const allFinished = assessments.flatMap((a) =>
    a.sessions.filter((s) => s.state !== "in_progress")
  );
  const allScored = allFinished.filter((s) => s.maxScore > 0);

  return NextResponse.json({
    // Sent so the browser can run the countdowns off the server's clock rather
    // than its own, which may be minutes out.
    serverNow: now,
    onlineGraceMs: ONLINE_GRACE_MS,
    kpis: {
      liveNow: liveRows.length,
      onlineNow: liveRows.filter((s) => now - s.lastSeenAt.getTime() <= ONLINE_GRACE_MS).length,
      flaggedLive: liveRows.filter((s) => s.violationCount > 0).length,
      openTests: assessments.filter((a) => a.isActive).length,
      totalTests: assessments.length,
      candidates: candidateCount,
      completed: allFinished.length,
      sessionsToday,
      submissionsToday,
      flaggedTotal,
      avgScorePct: allScored.length
        ? Math.round(
            allScored.reduce((s, r) => s + (r.totalScore / r.maxScore) * 100, 0) / allScored.length
          )
        : null,
      problemsTotal,
      problemsActive,
    },
    live: liveRows.map((s) => {
      const sum = liveSummaries.get(s.id)!;
      return {
        sessionId: s.id,
        candidateName: s.candidateName,
        candidateEmail: s.candidateEmail,
        image: s.user?.image ?? null,
        assessmentId: s.assessmentId,
        assessmentTitle: s.assessment.title,
        startedAt: s.startedAt,
        endsAt: s.endsAt,
        lastSeenAt: s.lastSeenAt,
        idleMs: Math.max(0, now - s.lastSeenAt.getTime()),
        violationCount: s.violationCount,
        maxViolations: s.assessment.maxViolations,
        totalScore: sum.totalScore,
        maxScore: sum.maxScore,
        solvedCount: sum.solvedCount,
        questionCount: sum.questionCount,
        submissionCount: sum.submissionCount,
      };
    }),
    tests,
    recent: recentRows.map((s) => ({
      sessionId: s.id,
      candidateName: s.candidateName,
      candidateEmail: s.candidateEmail,
      assessmentId: s.assessmentId,
      assessmentTitle: s.assessment.title,
      state: s.state,
      totalScore: s.totalScore,
      maxScore: s.maxScore,
      violationCount: s.violationCount,
      submittedAt: s.submittedAt,
      elapsedMs: sessionElapsedMs(s, now),
    })),
    events: eventRows.map((e) => ({
      id: e.id,
      event: e.event,
      detail: e.detail,
      counted: e.counted,
      createdAt: e.createdAt,
      sessionId: e.sessionId,
      // Null for events raised outside a proctored run — practice on the open
      // problem pages logs here too.
      candidateName: e.session?.candidateName ?? null,
      assessmentTitle: e.session?.assessment.title ?? null,
    })),
  });
}
