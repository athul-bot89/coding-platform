import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import {
  computeSessionScore,
  loadSessionProblems,
  sessionElapsedMs,
  sweepExpiredSessions,
} from "@/lib/assessment";
import { BURST_CHARS } from "@/lib/proctor-config";
import {
  ActivityMarker,
  IDLE_CAP_MS,
  buildTimeBreakdown,
  codeChanged,
  tallyVerdicts,
} from "@/lib/session-report";
import { isAccepted } from "@/lib/judge0-status";

/**
 * Everything known about one candidate's run.
 *
 * Deliberately whole-session: a reviewer deciding on a person should not have to
 * open four screens to see that the candidate ran their code eleven times before
 * a first submission, or that the question they scored nothing on is the one they
 * spent half the test in. What is *not* here is the bulky per-test-case I/O —
 * stdout alone reaches a megabyte on a runaway loop — which is fetched a single
 * attempt at a time from /api/admin/attempts/[id] when a reviewer opens one.
 */
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
      drafts: true,
      // Both kinds. Runs outnumber submissions two to one and are the better
      // record of how someone worked: a submission says what they arrived at,
      // the runs before it say how, and how long it took them to get there.
      attempts: {
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
  const elapsedMs = sessionElapsedMs(session);
  const metricByProblem = new Map(session.metrics.map((m) => [m.problemId, m]));
  const draftByProblem = new Map(session.drafts.map((d) => [d.problemId, d]));

  // The questions this candidate was served, not the assessment's current set —
  // the report has to reflect what they actually sat, edits since notwithstanding.
  const served = await loadSessionProblems(session.id);

  // ---- Time breakdown -------------------------------------------------------
  // Every timestamped, per-question fact in the session, from whichever table it
  // happens to live in. Draft saves matter most for the questions with no
  // submission at all: without them, work someone spent twenty minutes on and
  // never submitted leaves no trace whatsoever.
  const markers: ActivityMarker[] = [];
  for (const a of session.attempts) {
    markers.push({ problemId: a.problemId, atMs: a.createdAt.getTime() - startMs });
  }
  for (const d of session.drafts) {
    markers.push({ problemId: d.problemId, atMs: d.updatedAt.getTime() - startMs });
  }
  for (const m of session.metrics) {
    for (const b of safeParse(m.bursts)) {
      markers.push({ problemId: m.problemId, atMs: b.atMs });
    }
  }

  const timing = buildTimeBreakdown(markers, elapsedMs);

  const questions = served.map((ap) => {
    const score = perProblem.find((p) => p.problemId === ap.problemId);
    const mine = session.attempts.filter((a) => a.problemId === ap.problemId);
    const submits = mine.filter((a) => a.kind === "submit");
    const runs = mine.filter((a) => a.kind === "run");

    // Surface the submission that actually earned the points.
    const best = submits.reduce<(typeof submits)[number] | null>((acc, a) => {
      if (a.state !== "done" || a.maxScore === 0) return acc;
      if (!acc || a.score / a.maxScore > acc.score / acc.maxScore) return a;
      return acc;
    }, null);

    const m = metricByProblem.get(ap.problemId);
    const bursts = m ? safeParse(m.bursts) : [];
    const draft = draftByProblem.get(ap.problemId);
    const t = timing.byProblem.get(ap.problemId);

    // The whole history, one row per Run and Submit, in the order they happened.
    const history = mine.map((a, i) => {
      const cases = a.runs
        .slice()
        .sort((x, y) => x.testCase.ordinal - y.testCase.ordinal)
        .map((r) => ({
          ordinal: r.testCase.ordinal,
          kind: r.testCase.kind,
          statusId: r.statusId,
          timeS: r.timeS,
          memoryKb: r.memoryKb,
          // Enough to say *that* something was written to stderr or the compiler
          // complained, so a reviewer knows which case is worth opening. The text
          // itself comes from the per-attempt endpoint.
          hasOutput: !!(r.stderr || r.compileOutput || r.message),
        }));

      const prev = mine[i - 1];
      return {
        id: a.id,
        kind: a.kind,
        state: a.state,
        score: a.score,
        maxScore: a.maxScore,
        languageId: a.languageId,
        sourceCode: a.sourceCode,
        createdAt: a.createdAt,
        finishedAt: a.finishedAt,
        atMs: a.createdAt.getTime() - startMs,
        /** How long grading took, so a slow judge is not read as a slow candidate. */
        gradedInMs: a.finishedAt ? a.finishedAt.getTime() - a.createdAt.getTime() : null,
        /** False when this is a resubmission of byte-identical code. */
        changedSincePrevious: !prev || codeChanged(prev.sourceCode, a.sourceCode),
        slowestCaseS: cases.reduce((mx, c) => Math.max(mx, c.timeS ?? 0), 0) || null,
        peakMemoryKb: cases.reduce((mx, c) => Math.max(mx, c.memoryKb ?? 0), 0) || null,
        verdicts: tallyVerdicts(cases),
        cases,
      };
    });

    const bestCases = best ? history.find((h) => h.id === best.id)?.cases ?? [] : [];

    return {
      problemId: ap.problemId,
      title: ap.problem.title,
      slug: ap.problem.slug,
      difficulty: ap.problem.difficulty,
      ordinal: ap.ordinal,
      points: ap.points,
      earned: score?.earned ?? 0,
      submissions: submits.length,
      runCount: runs.length,
      totalTestCases: ap.problem.testCases.length,
      timeLimitMs: ap.problem.timeLimitMs,
      memoryLimitKb: ap.problem.memoryLimitKb,
      // Every language the candidate actually compiled under, in the order they
      // first used it — switching languages mid-question is worth seeing.
      languages: Array.from(new Set(mine.map((a) => a.languageId))),
      time: {
        estimatedMs: t?.estimatedMs ?? 0,
        firstTouchMs: t?.firstTouchMs ?? null,
        lastTouchMs: t?.lastTouchMs ?? null,
        markers: t?.markers ?? 0,
        /** Exact, but it is keystroke time and nothing else. See lib/session-report. */
        activeTypingMs: m?.activeMs ?? 0,
        /** From opening the question to the submission that scored, when there is one. */
        timeToBestMs: best ? best.createdAt.getTime() - startMs : null,
        timeToFirstSubmitMs: submits[0] ? submits[0].createdAt.getTime() - startMs : null,
        /** The earliest submission that passed everything, if any ever did. */
        timeToSolveMs: (() => {
          const solved = submits.find(
            (a) => a.state === "done" && a.maxScore > 0 && a.score === a.maxScore
          );
          return solved ? solved.createdAt.getTime() - startMs : null;
        })(),
      },
      bestAttempt: best
        ? {
            id: best.id,
            languageId: best.languageId,
            sourceCode: best.sourceCode,
            score: best.score,
            maxScore: best.maxScore,
            createdAt: best.createdAt,
            atMs: best.createdAt.getTime() - startMs,
            casesPassed: bestCases.filter((c) => isAccepted(c.statusId)).length,
            casesTotal: bestCases.length,
            runs: bestCases,
          }
        : null,
      history,
      // What was left in the editor. Only interesting when it is not simply the
      // last thing they submitted — which is the case that matters, because a
      // question with no submission currently reads as one never opened.
      draft: draft
        ? {
            code: draft.code,
            languageId: draft.languageId,
            updatedAt: draft.updatedAt,
            atMs: draft.updatedAt.getTime() - startMs,
            differsFromLastSubmission: codeChanged(
              submits[submits.length - 1]?.sourceCode,
              draft.code
            ),
          }
        : null,
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
      // Kept for compatibility with anything still reading the old shape; the
      // page now renders `history`, of which this is the submissions half.
      timeline: submits.map((a) => ({
        id: a.id,
        atMs: a.createdAt.getTime() - startMs,
        score: a.score,
        maxScore: a.maxScore,
        state: a.state,
        languageId: a.languageId,
      })),
    };
  });

  const attempted = questions.filter((q) => q.time.markers > 0);
  const graded = questions.flatMap((q) => q.history).filter((h) => h.gradedInMs !== null);

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
    lastSeenAt: session.lastSeenAt,
    durationMinutes: session.assessment.durationMinutes,
    elapsedMs,
    // Time added back for being offline. Reported so a candidate whose test ran
    // nine minutes long has that explained rather than looking like a clock bug —
    // and so an implausible amount of "connection trouble" is visible.
    creditedMs: session.creditedMs,
    violationCount: session.violationCount,
    maxViolations: session.assessment.maxViolations,
    totalScore,
    maxScore,
    totals: {
      questions: questions.length,
      attempted: attempted.length,
      solved: questions.filter((q) => q.points > 0 && q.earned >= q.points).length,
      partial: questions.filter((q) => q.earned > 0 && q.earned < q.points).length,
      untouched: questions.length - attempted.length,
      submissions: questions.reduce((s, q) => s + q.submissions, 0),
      runs: questions.reduce((s, q) => s + q.runCount, 0),
      keystrokes: questions.reduce((s, q) => s + (q.integrity?.keystrokes ?? 0), 0),
      charsTyped: questions.reduce((s, q) => s + (q.integrity?.charsTyped ?? 0), 0),
      activeTypingMs: questions.reduce((s, q) => s + q.time.activeTypingMs, 0),
      /** Window time no question could be credited with. See lib/session-report. */
      unattributedMs: timing.unattributedMs,
      idleCapMs: IDLE_CAP_MS,
      medianGradingMs: median(graded.map((h) => h.gradedInMs!)),
    },
    events: session.events.map((e) => ({
      id: e.id,
      event: e.event,
      detail: e.detail,
      counted: e.counted,
      atMs: e.createdAt.getTime() - startMs,
      createdAt: e.createdAt,
    })),
    questions,
  });
}

/**
 * Clear a candidate's run so they can take the test again.
 *
 * One run per account is enforced by the unique (assessmentId, userId) index, so
 * removing the row is the only thing that reopens the link for them. Everything
 * hanging off it goes too — submissions, proctor log, drafts, typing metrics and
 * the frozen question set all cascade — which is why this is destructive rather
 * than a state change: a retake that kept the old attempts would score against
 * work from the first sitting.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const existing = await prisma.testSession.findUnique({
    where: { id: params.id },
    select: { id: true, candidateEmail: true, assessmentId: true },
  });

  // Prisma turns a delete against a missing row into a throw, which would read
  // as a server fault rather than the stale list it usually is.
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.testSession.delete({ where: { id: params.id } });

  return NextResponse.json({
    ok: true,
    assessmentId: existing.assessmentId,
    candidateEmail: existing.candidateEmail,
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function safeParse(s: string | null): { atMs: number; chars: number }[] {
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
