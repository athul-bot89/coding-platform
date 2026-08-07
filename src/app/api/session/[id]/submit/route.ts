import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";
import { createAttempt } from "@/lib/grading";

/**
 * Submit (all test cases) or Run (sample cases only) inside a proctored session.
 *
 * The guard rejects anything arriving after `endsAt`, so a submission fired at
 * the buzzer either lands in time or not at all — the client clock is irrelevant.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session, userId } = guard;

  const { problemId, languageId, sourceCode, kind } = await req.json().catch(() => ({}));

  if (!problemId || !languageId || typeof sourceCode !== "string") {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!sourceCode.trim()) {
    return NextResponse.json({ error: "Write some code first" }, { status: 400 });
  }

  const entry = session.invitation.assessment.problems.find((p) => p.problemId === problemId);
  if (!entry) {
    return NextResponse.json({ error: "Problem not in this test" }, { status: 400 });
  }

  const problem = entry.problem;
  const allowedLangs = problem.allowedLanguages.split(",").map(Number);
  if (!allowedLangs.includes(languageId)) {
    return NextResponse.json({ error: "Language not allowed for this problem" }, { status: 400 });
  }

  // Persist the draft alongside the submission so a crash right after submitting
  // still restores exactly what was sent.
  await prisma.sessionDraft.upsert({
    where: { sessionId_problemId: { sessionId: session.id, problemId } },
    create: { sessionId: session.id, problemId, languageId, code: sourceCode },
    update: { languageId, code: sourceCode },
  });

  try {
    const attemptId = await createAttempt({
      userId,
      problem,
      languageId,
      sourceCode,
      kind: kind === "run" ? "run" : "submit",
      sessionId: session.id,
    });
    return NextResponse.json({ attemptId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Execution failed" }, { status: 500 });
  }
}
