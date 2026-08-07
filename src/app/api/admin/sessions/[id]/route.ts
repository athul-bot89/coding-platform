import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { computeSessionScore, loadSessionProblems, sweepExpiredSessions } from "@/lib/assessment";
import { BURST_CHARS } from "@/lib/proctor-config";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  await sweepExpiredSessions();

  const session = await prisma.testSession.findUnique({
    where: { id: params.id },
    include: {
      user: { select: { name: true, email: true, image: true } },
      assessment: true,
      events: { orderBy: { createdAt: "asc" } },
      metrics: true,
      attempts: {
        where: { kind: "submit" },
        orderBy: { createdAt: "asc" },
        include: { runs: { include: { testCase: { select: { ordinal: true, kind: true } } } } },
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { perProblem, totalScore, maxScore } = await computeSessionScore(session.id);
  const startMs = session.startedAt.getTime();
  const metricByProblem = new Map(session.metrics.map((m) => [m.problemId, m]));

  // The questions this candidate was served, not the assessment's current set —
  // the report has to reflect what they actually sat, edits since notwithstanding.
  const served = await loadSessionProblems(session.id);

  const questions = served.map((ap) => {
    const score = perProblem.find((p) => p.problemId === ap.problemId);
    const attempts = session.attempts.filter((a) => a.problemId === ap.problemId);

    // Surface the submission that actually earned the points.
    const best = attempts.reduce<(typeof attempts)[number] | null>((acc, a) => {
      if (a.state !== "done" || a.maxScore === 0) return acc;
      if (!acc || a.score / a.maxScore > acc.score / acc.maxScore) return a;
      return acc;
    }, null);

    const m = metricByProblem.get(ap.problemId);
    const bursts: { atMs: number; chars: number }[] = m?.bursts ? safeParse(m.bursts) : [];

    return {
      problemId: ap.problemId,
      title: ap.problem.title,
      ordinal: ap.ordinal,
      points: ap.points,
      earned: score?.earned ?? 0,
      submissions: attempts.length,
      bestAttempt: best
        ? {
            id: best.id,
            languageId: best.languageId,
            sourceCode: best.sourceCode,
            score: best.score,
            maxScore: best.maxScore,
            createdAt: best.createdAt,
            runs: best.runs
              .sort((a, b) => a.testCase.ordinal - b.testCase.ordinal)
              .map((r) => ({
                ordinal: r.testCase.ordinal,
                kind: r.testCase.kind,
                statusId: r.statusId,
                timeS: r.timeS,
                memoryKb: r.memoryKb,
              })),
          }
        : null,
      timeline: attempts.map((a) => ({
        id: a.id,
        atMs: a.createdAt.getTime() - startMs,
        score: a.score,
        maxScore: a.maxScore,
        state: a.state,
        languageId: a.languageId,
      })),
      integrity: m
        ? {
            keystrokes: m.keystrokes,
            charsTyped: m.charsTyped,
            activeMs: m.activeMs,
            largestInsertion: m.largestInsertion,
            burstCount: m.burstCount,
            burstChars: bursts.reduce((s, b) => s + b.chars, 0),
            bursts: bursts.slice(-25),
            threshold: BURST_CHARS,
          }
        : null,
    };
  });

  return NextResponse.json({
    id: session.id,
    assessmentTitle: session.assessment.title,
    assessmentId: session.assessmentId,
    // Captured at start. `signedInAs` reads the account row as it stands now, so
    // the two differ when the candidate has since renamed or changed the address
    // on their Google account — the report shows who actually sat the test.
    candidateName: session.candidateName,
    candidateEmail: session.candidateEmail,
    signedInAs: session.user.email,
    signedInName: session.user.name,
    image: session.user.image,
    state: session.state,
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    submittedAt: session.submittedAt,
    durationMinutes: session.assessment.durationMinutes,
    // Capped at the deadline: a candidate who walked away cannot have used more
    // time than the test allowed, however long it took for anyone to notice.
    elapsedMs: Math.max(
      0,
      Math.min((session.submittedAt ?? new Date()).getTime(), session.endsAt.getTime()) - startMs
    ),
    violationCount: session.violationCount,
    maxViolations: session.assessment.maxViolations,
    totalScore,
    maxScore,
    questions,
    events: session.events.map((e) => ({
      id: e.id,
      event: e.event,
      detail: e.detail,
      counted: e.counted,
      atMs: e.createdAt.getTime() - startMs,
      createdAt: e.createdAt,
    })),
  });
}

function safeParse(s: string): { atMs: number; chars: number }[] {
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
