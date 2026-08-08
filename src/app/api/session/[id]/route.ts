import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";
import { remainingMs } from "@/lib/assessment";

// Full state needed to render (or re-render, after a refresh) the test screen.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session, problems: served } = guard;

  const assessment = session.assessment;

  // Loading the test screen claims tab ownership. Any older tab still open will
  // find out it has been evicted on its next heartbeat.
  const tabId = new URL(req.url).searchParams.get("tabId");
  if (tabId) {
    await prisma.testSession.update({
      where: { id: session.id },
      data: { tabLock: tabId, lastSeenAt: new Date() },
    });
  }

  const [drafts, attempts] = await Promise.all([
    prisma.sessionDraft.findMany({ where: { sessionId: session.id } }),
    prisma.attempt.findMany({
      where: { sessionId: session.id, kind: "submit" },
      select: { problemId: true, score: true, maxScore: true, state: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const draftByProblem = new Map(drafts.map((d) => [d.problemId, d]));

  const problems = served.map((sp, index) => {
    const p = sp.problem;
    const starter: Record<string, string> = p.starterCode ? JSON.parse(p.starterCode) : {};
    const mine = attempts.filter((a) => a.problemId === p.id);
    const bestRatio = mine.reduce(
      (best, a) => (a.state === "done" && a.maxScore > 0 ? Math.max(best, a.score / a.maxScore) : best),
      0
    );
    const draft = draftByProblem.get(p.id);

    return {
      index,
      id: p.id,
      title: p.title,
      description: p.description,
      difficulty: p.difficulty,
      points: sp.points,
      allowedLanguages: p.allowedLanguages.split(",").map(Number),
      timeLimitMs: p.timeLimitMs,
      memoryLimitKb: p.memoryLimitKb,
      starterCode: starter,
      sampleTestCases: p.testCases
        .filter((tc) => tc.kind === "sample")
        .map((tc) => ({ ordinal: tc.ordinal, stdin: tc.stdin, expectedOutput: tc.expectedOutput })),
      totalTestCount: p.testCases.length,
      // Progress only — never the score itself, which stays hidden until review.
      submissionCount: mine.length,
      solved: bestRatio >= 1,
      attempted: mine.length > 0 || !!draft,
      // `savedAt` lets the client see how its own local mirror compares with what
      // actually reached the server, so code typed during an outage is restored
      // rather than being overwritten by an older server-side copy.
      draft: draft
        ? {
            code: draft.code,
            languageId: draft.languageId,
            savedAt: draft.updatedAt.getTime(),
          }
        : null,
    };
  });

  return NextResponse.json({
    id: session.id,
    title: assessment.title,
    // The same admin-authored markdown shown before the test started, so the
    // rules panel inside the editor can repeat it without a second request.
    instructions: assessment.instructions,
    candidateName: session.candidateName,
    remainingMs: remainingMs(session.endsAt),
    endsAt: session.endsAt,
    // `startedAt` with `serverNow` lets the client place an event on the session's
    // own timeline without trusting its own clock's absolute value — needed for
    // anything reported late, such as an outage that is only logged once it ends.
    startedAt: session.startedAt,
    serverNow: Date.now(),
    violationCount: session.violationCount,
    maxViolations: assessment.maxViolations,
    // Already-credited outage time, so a candidate who reloads still sees that
    // their clock was extended rather than thinking it drifted.
    creditedMs: session.creditedMs,
    problems,
  });
}
