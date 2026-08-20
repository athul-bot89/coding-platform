import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";

/**
 * One attempt in full: the code, and every test case with its input, the output
 * it was supposed to produce, and the output it actually produced.
 *
 * Split out from the session report rather than folded into it because this is
 * the only genuinely large payload in the system — a runaway loop can leave a
 * megabyte of stdout on a single case, and a session holds seventy attempts. A
 * reviewer opens two or three of them, so they are fetched when opened.
 *
 * Hidden cases are shown here in full. This route is admin-only, and a review
 * that cannot see which input broke the code cannot say anything useful about it.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const attempt = await prisma.attempt.findUnique({
    where: { id: params.id },
    include: {
      problem: { select: { id: true, title: true, timeLimitMs: true, memoryLimitKb: true } },
      runs: { include: { testCase: true } },
    },
  });

  if (!attempt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: attempt.id,
    kind: attempt.kind,
    state: attempt.state,
    score: attempt.score,
    maxScore: attempt.maxScore,
    languageId: attempt.languageId,
    sourceCode: attempt.sourceCode,
    createdAt: attempt.createdAt,
    finishedAt: attempt.finishedAt,
    problem: attempt.problem,
    runs: attempt.runs
      .slice()
      .sort((a, b) => a.testCase.ordinal - b.testCase.ordinal)
      .map((r) => ({
        id: r.id,
        ordinal: r.testCase.ordinal,
        kind: r.testCase.kind,
        weight: r.testCase.weight,
        statusId: r.statusId,
        exitCode: r.exitCode,
        timeS: r.timeS,
        memoryKb: r.memoryKb,
        polledAt: r.polledAt,
        ...clip("stdin", r.testCase.stdin),
        ...clip("expectedOutput", r.testCase.expectedOutput),
        ...clip("stdout", r.stdout),
        ...clip("stderr", r.stderr),
        ...clip("compileOutput", r.compileOutput),
        message: r.message,
      })),
  });
}

/**
 * Ceiling on any one text field. Well past the point where more of it tells a
 * reviewer anything — output this long is a bug in the candidate's code, which
 * the first few hundred characters already demonstrate.
 */
const MAX_FIELD_CHARS = 8_000;

function clip(field: string, value: string | null): Record<string, unknown> {
  if (value === null || value === undefined) return { [field]: null };
  if (value.length <= MAX_FIELD_CHARS) return { [field]: value };
  return {
    [field]: value.slice(0, MAX_FIELD_CHARS),
    [`${field}Truncated`]: value.length,
  };
}
