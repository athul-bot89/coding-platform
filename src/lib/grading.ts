import { prisma } from "@/lib/prisma";
import { createBatchSubmissions, getBatchSubmissions, isTerminal } from "@/lib/judge0";

export const JUDGE0_ACCEPTED = 3;

type ProblemWithCases = {
  id: string;
  allowedLanguages: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  testCases: { id: string; ordinal: number; kind: string; stdin: string; expectedOutput: string; weight: number }[];
};

/**
 * Dispatch one attempt to Judge0 and create its AttemptRun rows.
 *
 * `kind: "run"` grades sample cases only, so a candidate can iterate without
 * revealing hidden-case behaviour; `kind: "submit"` grades everything.
 * Returns the created attempt id.
 */
export async function createAttempt(opts: {
  userId: string;
  problem: ProblemWithCases;
  languageId: number;
  sourceCode: string;
  kind?: "submit" | "run";
  sessionId?: string | null;
}): Promise<string> {
  const kind = opts.kind ?? "submit";
  const cases =
    kind === "run"
      ? opts.problem.testCases.filter((tc) => tc.kind === "sample")
      : opts.problem.testCases;

  if (cases.length === 0) {
    throw new Error(
      kind === "run" ? "This problem has no sample cases to run" : "This problem has no test cases"
    );
  }

  const attempt = await prisma.attempt.create({
    data: {
      userId: opts.userId,
      problemId: opts.problem.id,
      sessionId: opts.sessionId ?? null,
      kind,
      languageId: opts.languageId,
      sourceCode: opts.sourceCode,
      state: "queued",
      maxScore: cases.reduce((sum, tc) => sum + tc.weight, 0),
    },
  });

  try {
    const tokens = await createBatchSubmissions(
      cases.map((tc) => ({
        language_id: opts.languageId,
        source_code: opts.sourceCode,
        stdin: tc.stdin,
        expected_output: tc.expectedOutput,
        cpu_time_limit: opts.problem.timeLimitMs / 1000,
        memory_limit: opts.problem.memoryLimitKb,
      }))
    );

    await prisma.attemptRun.createMany({
      data: cases.map((tc, i) => ({
        attemptId: attempt.id,
        testCaseId: tc.id,
        judge0Token: tokens[i] || null,
      })),
    });

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { state: "running" },
    });

    return attempt.id;
  } catch (err) {
    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { state: "error", finishedAt: new Date() },
    });
    throw err;
  }
}

/**
 * Poll Judge0 for any still-pending runs on an attempt, persist the results, and
 * finalize the score once every run has reached a terminal status.
 *
 * Safe to call repeatedly — it's the single grading path used by both the
 * practice flow and proctored sessions.
 */
export async function pollAndScoreAttempt(attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { runs: { include: { testCase: true } } },
  });

  if (!attempt || attempt.state !== "running") return attempt;

  // A run with no token means Judge0 rejected that slot outright. Mark it failed
  // rather than leaving the attempt stuck in "running" forever.
  const orphaned = attempt.runs.filter((r) => !r.judge0Token && !r.statusId);
  if (orphaned.length > 0) {
    await prisma.attemptRun.updateMany({
      where: { id: { in: orphaned.map((r) => r.id) } },
      data: { statusId: 13, message: "Judge0 did not accept this submission", polledAt: new Date() },
    });
  }

  const pendingRuns = attempt.runs.filter(
    (r) => r.judge0Token && (!r.statusId || !isTerminal(r.statusId))
  );

  if (pendingRuns.length > 0) {
    try {
      const results = await getBatchSubmissions(pendingRuns.map((r) => r.judge0Token!));

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const run = pendingRuns[i];
        if (!run || !result?.status || !isTerminal(result.status.id)) continue;

        await prisma.attemptRun.update({
          where: { id: run.id },
          data: {
            statusId: result.status.id,
            exitCode: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            compileOutput: result.compile_output,
            message: result.message,
            timeS: result.time ? parseFloat(result.time) : null,
            memoryKb: result.memory,
            polledAt: new Date(),
          },
        });
      }
    } catch {
      // Transient Judge0 failure — the next poll retries.
    }
  }

  const updatedRuns = await prisma.attemptRun.findMany({
    where: { attemptId },
    include: { testCase: true },
  });

  const allDone = updatedRuns.length > 0 && updatedRuns.every((r) => r.statusId && isTerminal(r.statusId));

  if (allDone) {
    const score = updatedRuns.reduce(
      (sum, r) => sum + (r.statusId === JUDGE0_ACCEPTED ? r.testCase.weight : 0),
      0
    );
    await prisma.attempt.update({
      where: { id: attemptId },
      data: { state: "done", score, finishedAt: new Date() },
    });
  }

  return prisma.attempt.findUnique({
    where: { id: attemptId },
    include: { runs: { include: { testCase: true } } },
  });
}

/** Shape an attempt for the client, hiding hidden-case I/O from non-admins. */
export function formatAttemptResponse(attempt: any, isAdmin: boolean) {
  const runs = [...attempt.runs].sort(
    (a: any, b: any) => a.testCase.ordinal - b.testCase.ordinal
  );

  return {
    id: attempt.id,
    kind: attempt.kind,
    state: attempt.state,
    score: attempt.score,
    maxScore: attempt.maxScore,
    languageId: attempt.languageId,
    createdAt: attempt.createdAt,
    finishedAt: attempt.finishedAt,
    runs: runs.map((r: any) => {
      const visible = r.testCase.kind === "sample" || isAdmin;
      return {
        id: r.id,
        ordinal: r.testCase.ordinal,
        kind: r.testCase.kind,
        statusId: r.statusId,
        stdout: visible ? r.stdout : null,
        stderr: visible ? r.stderr : null,
        compileOutput: r.compileOutput,
        message: r.message,
        timeS: r.timeS,
        memoryKb: r.memoryKb,
        stdin: visible ? r.testCase.stdin : null,
        expectedOutput: visible ? r.testCase.expectedOutput : null,
      };
    }),
  };
}

export const JUDGE0_STATUS_LABELS: Record<number, string> = {
  1: "In Queue",
  2: "Processing",
  3: "Accepted",
  4: "Wrong Answer",
  5: "Time Limit Exceeded",
  6: "Compilation Error",
  7: "Runtime Error (SIGSEGV)",
  8: "Runtime Error (SIGXFSZ)",
  9: "Runtime Error (SIGFPE)",
  10: "Runtime Error (SIGABRT)",
  11: "Runtime Error (NZEC)",
  12: "Runtime Error",
  13: "Internal Error",
  14: "Exec Format Error",
};

export function statusLabel(statusId: number | null): string {
  if (!statusId) return "Pending";
  return JUDGE0_STATUS_LABELS[statusId] || "Error";
}
