import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock Prisma (factory-based to avoid hoisting issues) ----
vi.mock("@/lib/prisma", () => ({
  prisma: {
    testSession: { count: vi.fn() },
    problem: { findFirst: vi.fn() },
    attempt: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    attemptRun: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

// ---- Mock Judge0 ----
// Only the HTTP calls are faked; `isTerminal` delegates to the real status rules
// so the polling tests exercise the same terminal/pending boundary as production.
vi.mock("@/lib/judge0", async () => {
  const { isTerminalStatus } = await import("@/lib/judge0-status");
  return {
    createBatchSubmissions: vi.fn(),
    getBatchSubmissions: vi.fn(),
    isTerminal: vi.fn(isTerminalStatus),
  };
});

// ---- Mock auth ----
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(() => Promise.resolve({ user: { id: "admin-1", email: "admin@test.com" } })),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/admin-guard", () => ({
  requireAdmin: vi.fn(() => Promise.resolve({ userId: "admin-1" })),
}));

import { createAttempt, pollAndScoreAttempt, formatAttemptResponse } from "@/lib/grading";
import { prisma } from "@/lib/prisma";
import { createBatchSubmissions, getBatchSubmissions } from "@/lib/judge0";
import {
  JUDGE0_ACCEPTED,
  JUDGE0_WRONG_ANSWER,
  JUDGE0_PROCESSING,
  JUDGE0_INTERNAL_ERROR,
} from "@/lib/judge0-status";

const mockPrisma = vi.mocked(prisma, true);
const mockCreateBatch = vi.mocked(createBatchSubmissions);
const mockGetBatch = vi.mocked(getBatchSubmissions);

describe("integration: practice submit flow (createAttempt)", () => {
  const mockProblem = {
    id: "prob-1",
    allowedLanguages: "71,62,54",
    timeLimitMs: 2000,
    memoryLimitKb: 256000,
    testCases: [
      { id: "tc-1", ordinal: 1, kind: "sample", stdin: "hello\n", expectedOutput: "HELLO\n", weight: 25 },
      { id: "tc-2", ordinal: 2, kind: "hidden", stdin: "world\n", expectedOutput: "WORLD\n", weight: 25 },
      { id: "tc-3", ordinal: 3, kind: "hidden", stdin: "foo\n", expectedOutput: "FOO\n", weight: 50 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (mockPrisma.attempt.create as any).mockResolvedValue({ id: "attempt-new" });
    (mockPrisma.attempt.update as any).mockResolvedValue({ id: "attempt-new" });
    (mockPrisma.attemptRun.createMany as any).mockResolvedValue({ count: 3 });
    mockCreateBatch.mockResolvedValue(["tok-1", "tok-2", "tok-3"] as any);
  });

  it("creates attempt with all test cases on 'submit' kind", async () => {
    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "print(input().upper())",
      kind: "submit",
    });

    expect(mockPrisma.attempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "submit",
          maxScore: 100,
          state: "queued",
        }),
      })
    );
    expect(mockCreateBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ stdin: "hello\n" }),
        expect.objectContaining({ stdin: "world\n" }),
        expect.objectContaining({ stdin: "foo\n" }),
      ])
    );
  });

  it("creates attempt with only sample cases on 'run' kind", async () => {
    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "print(input().upper())",
      kind: "run",
    });

    expect(mockPrisma.attempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "run",
          maxScore: 25, // only sample weight
        }),
      })
    );
    expect(mockCreateBatch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ stdin: "hello\n" })])
    );
    // Should NOT include hidden cases
    expect(mockCreateBatch).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ stdin: "world\n" })])
    );
  });

  it("defaults to a full submit when no kind is given", async () => {
    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "code",
    });

    expect(mockPrisma.attempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "submit", maxScore: 100 }) })
    );
  });

  it("throws when no test cases exist for the chosen kind", async () => {
    const noSamples = {
      ...mockProblem,
      testCases: mockProblem.testCases.filter((tc) => tc.kind !== "sample"),
    };

    await expect(
      createAttempt({
        userId: "admin-1",
        problem: noSamples,
        languageId: 71,
        sourceCode: "code",
        kind: "run",
      })
    ).rejects.toThrow("no sample cases");

    // Nothing was dispatched, and no attempt row was left behind.
    expect(mockPrisma.attempt.create).not.toHaveBeenCalled();
    expect(mockCreateBatch).not.toHaveBeenCalled();
  });

  it("passes correct cpu_time_limit and memory_limit to Judge0", async () => {
    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "code",
      kind: "submit",
    });

    const batchCalls = mockCreateBatch.mock.calls[0][0];
    for (const sub of batchCalls) {
      expect(sub.cpu_time_limit).toBe(2); // 2000ms / 1000
      expect(sub.memory_limit).toBe(256000);
    }
  });

  it("stores attempt runs with correct tokens", async () => {
    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "code",
      kind: "submit",
    });

    expect(mockPrisma.attemptRun.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ judge0Token: "tok-1" }),
          expect.objectContaining({ judge0Token: "tok-2" }),
          expect.objectContaining({ judge0Token: "tok-3" }),
        ]),
      })
    );
  });

  it("marks the attempt running once every token is stored", async () => {
    const id = await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "code",
    });

    expect(id).toBe("attempt-new");
    expect(mockPrisma.attempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-new" },
      data: { state: "running" },
    });
  });

  it("records a token slot Judge0 refused as null rather than shifting the rest", async () => {
    mockCreateBatch.mockResolvedValue(["tok-1", undefined, "tok-3"] as any);

    await createAttempt({
      userId: "admin-1",
      problem: mockProblem,
      languageId: 71,
      sourceCode: "code",
    });

    const { data } = (mockPrisma.attemptRun.createMany as any).mock.calls[0][0];
    expect(data.map((r: any) => [r.testCaseId, r.judge0Token])).toEqual([
      ["tc-1", "tok-1"],
      ["tc-2", null],
      ["tc-3", "tok-3"],
    ]);
  });

  it("marks the attempt errored and rethrows when Judge0 dispatch fails", async () => {
    mockCreateBatch.mockRejectedValue(new Error("judge0 unreachable"));

    await expect(
      createAttempt({ userId: "admin-1", problem: mockProblem, languageId: 71, sourceCode: "code" })
    ).rejects.toThrow("judge0 unreachable");

    // Otherwise the attempt sits in "queued" forever and the poller never touches it.
    expect(mockPrisma.attempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-new" },
      data: { state: "error", finishedAt: expect.any(Date) },
    });
  });
});

describe("integration: polling and scoring (pollAndScoreAttempt)", () => {
  const CASE = {
    a: { id: "tc-1", ordinal: 1, kind: "sample", stdin: "1\n", expectedOutput: "1\n", weight: 30 },
    b: { id: "tc-2", ordinal: 2, kind: "hidden", stdin: "2\n", expectedOutput: "2\n", weight: 70 },
  };

  /** An attempt whose runs are all pending, created `ageMs` ago. */
  function running(ageMs = 60_000, runs?: any[]) {
    return {
      id: "attempt-1",
      state: "running",
      createdAt: new Date(Date.now() - ageMs),
      runs:
        runs ??
        [
          { id: "run-a", judge0Token: "tok-a", statusId: null, testCase: CASE.a },
          { id: "run-b", judge0Token: "tok-b", statusId: null, testCase: CASE.b },
        ],
    };
  }

  function judged(statusId: number, over: Record<string, any> = {}) {
    return {
      status: { id: statusId },
      exit_code: 0,
      stdout: "out\n",
      stderr: null,
      compile_output: null,
      message: null,
      time: "0.05",
      memory: 3000,
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (mockPrisma.attempt.update as any).mockResolvedValue({});
    (mockPrisma.attemptRun.update as any).mockResolvedValue({});
    (mockPrisma.attemptRun.updateMany as any).mockResolvedValue({ count: 0 });
    (mockPrisma.attemptRun.findMany as any).mockResolvedValue([]);
  });

  it("does nothing for an attempt that is not running", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue({ ...running(), state: "done" });

    await pollAndScoreAttempt("attempt-1");

    expect(mockGetBatch).not.toHaveBeenCalled();
    expect(mockPrisma.attempt.update).not.toHaveBeenCalled();
  });

  it("does nothing for an attempt that does not exist", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(null);

    await expect(pollAndScoreAttempt("nope")).resolves.toBeNull();
    expect(mockGetBatch).not.toHaveBeenCalled();
  });

  it("fails a run Judge0 never accepted instead of leaving it pending forever", async () => {
    const runs = [
      { id: "run-a", judge0Token: null, statusId: null, testCase: CASE.a },
      { id: "run-b", judge0Token: "tok-b", statusId: null, testCase: CASE.b },
    ];
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running(60_000, runs));
    mockGetBatch.mockResolvedValue([{ token: "tok-b", ...judged(JUDGE0_ACCEPTED) }] as any);

    await pollAndScoreAttempt("attempt-1");

    expect(mockPrisma.attemptRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-a"] } },
        data: expect.objectContaining({ statusId: JUDGE0_INTERNAL_ERROR }),
      })
    );
    // Only the run that actually has a token is polled.
    expect(mockGetBatch).toHaveBeenCalledWith(["tok-b"]);
  });

  it("matches each verdict to the run holding its token, not to its array position", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    // Judge0 answers in the opposite order to the batch it was sent.
    mockGetBatch.mockResolvedValue([
      { token: "tok-b", ...judged(JUDGE0_WRONG_ANSWER) },
      { token: "tok-a", ...judged(JUDGE0_ACCEPTED) },
    ] as any);

    await pollAndScoreAttempt("attempt-1");

    const byRun = new Map(
      (mockPrisma.attemptRun.update as any).mock.calls.map((c: any[]) => [
        c[0].where.id,
        c[0].data.statusId,
      ])
    );
    expect(byRun.get("run-a")).toBe(JUDGE0_ACCEPTED);
    expect(byRun.get("run-b")).toBe(JUDGE0_WRONG_ANSWER);
  });

  it("ignores a result whose token matches nothing pending", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockResolvedValue([
      { token: "tok-a", ...judged(JUDGE0_ACCEPTED) },
      { token: "tok-from-another-attempt", ...judged(JUDGE0_ACCEPTED) },
    ] as any);

    await pollAndScoreAttempt("attempt-1");

    const ids = (mockPrisma.attemptRun.update as any).mock.calls.map((c: any[]) => c[0].where.id);
    expect(ids).toEqual(["run-a"]);
  });

  it("leaves a still-processing run alone", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockResolvedValue([
      { token: "tok-a", ...judged(JUDGE0_PROCESSING) },
      { token: "tok-b", ...judged(JUDGE0_ACCEPTED) },
    ] as any);

    await pollAndScoreAttempt("attempt-1");

    const ids = (mockPrisma.attemptRun.update as any).mock.calls.map((c: any[]) => c[0].where.id);
    expect(ids).toEqual(["run-b"]);
  });

  it("persists the whole verdict, converting Judge0's stringified time", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockResolvedValue([
      { token: "tok-a", ...judged(JUDGE0_ACCEPTED, { time: "1.25", memory: 4096 }) },
    ] as any);

    await pollAndScoreAttempt("attempt-1");

    expect(mockPrisma.attemptRun.update).toHaveBeenCalledWith({
      where: { id: "run-a" },
      data: expect.objectContaining({
        statusId: JUDGE0_ACCEPTED,
        stdout: "out\n",
        timeS: 1.25,
        memoryKb: 4096,
        polledAt: expect.any(Date),
      }),
    });
  });

  it("gives a freshly issued token the benefit of the doubt when Judge0 disowns it", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running(5_000));
    mockGetBatch.mockResolvedValue([{ token: "tok-a" }, { token: "tok-b" }] as any);

    await pollAndScoreAttempt("attempt-1");

    // Inside the grace window this is a race, not a verdict — wait for one more poll.
    expect(mockPrisma.attemptRun.update).not.toHaveBeenCalled();
  });

  it("fails a disowned token once the attempt is past the grace window", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running(120_000));
    mockGetBatch.mockResolvedValue([{ token: "tok-a" }, { token: "tok-b" }] as any);

    await pollAndScoreAttempt("attempt-1");

    for (const id of ["run-a", "run-b"]) {
      expect(mockPrisma.attemptRun.update).toHaveBeenCalledWith({
        where: { id },
        data: expect.objectContaining({ statusId: JUDGE0_INTERNAL_ERROR }),
      });
    }
  });

  it("survives a transient Judge0 outage without touching the attempt", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockRejectedValue(new Error("ECONNRESET"));

    await expect(pollAndScoreAttempt("attempt-1")).resolves.not.toThrow();

    expect(mockPrisma.attemptRun.update).not.toHaveBeenCalled();
    expect(mockPrisma.attempt.update).not.toHaveBeenCalled();
  });

  it("scores only the accepted cases once every run is terminal", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockResolvedValue([
      { token: "tok-a", ...judged(JUDGE0_ACCEPTED) },
      { token: "tok-b", ...judged(JUDGE0_WRONG_ANSWER) },
    ] as any);
    (mockPrisma.attemptRun.findMany as any).mockResolvedValue([
      { id: "run-a", statusId: JUDGE0_ACCEPTED, testCase: CASE.a },
      { id: "run-b", statusId: JUDGE0_WRONG_ANSWER, testCase: CASE.b },
    ]);

    await pollAndScoreAttempt("attempt-1");

    expect(mockPrisma.attempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-1" },
      data: { state: "done", score: 30, finishedAt: expect.any(Date) },
    });
  });

  it("does not finalize while any run is still pending", async () => {
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running());
    mockGetBatch.mockResolvedValue([{ token: "tok-a", ...judged(JUDGE0_ACCEPTED) }] as any);
    (mockPrisma.attemptRun.findMany as any).mockResolvedValue([
      { id: "run-a", statusId: JUDGE0_ACCEPTED, testCase: CASE.a },
      { id: "run-b", statusId: null, testCase: CASE.b },
    ]);

    await pollAndScoreAttempt("attempt-1");

    expect(mockPrisma.attempt.update).not.toHaveBeenCalled();
  });

  it("is safe to call again on an attempt whose runs are already scored", async () => {
    const settled = [
      { id: "run-a", judge0Token: "tok-a", statusId: JUDGE0_ACCEPTED, testCase: CASE.a },
      { id: "run-b", judge0Token: "tok-b", statusId: JUDGE0_ACCEPTED, testCase: CASE.b },
    ];
    (mockPrisma.attempt.findUnique as any).mockResolvedValue(running(60_000, settled));
    (mockPrisma.attemptRun.findMany as any).mockResolvedValue(settled);

    await pollAndScoreAttempt("attempt-1");

    expect(mockGetBatch).not.toHaveBeenCalled();
    expect(mockPrisma.attempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-1" },
      data: { state: "done", score: 100, finishedAt: expect.any(Date) },
    });
  });
});

describe("formatAttemptResponse", () => {
  const attempt = {
    id: "attempt-1",
    kind: "submit",
    state: "done",
    score: 30,
    maxScore: 100,
    languageId: 71,
    createdAt: new Date(0),
    finishedAt: new Date(1),
    runs: [
      {
        id: "run-b",
        statusId: JUDGE0_WRONG_ANSWER,
        stdout: "wrong\n",
        stderr: "boom\n",
        compileOutput: null,
        message: null,
        timeS: 0.1,
        memoryKb: 3000,
        testCase: {
          ordinal: 2,
          kind: "hidden",
          stdin: "secret in\n",
          expectedOutput: "secret out\n",
          weight: 70,
        },
      },
      {
        id: "run-a",
        statusId: JUDGE0_ACCEPTED,
        stdout: "ok\n",
        stderr: null,
        compileOutput: null,
        message: null,
        timeS: 0.2,
        memoryKb: 3100,
        testCase: { ordinal: 1, kind: "sample", stdin: "1\n", expectedOutput: "1\n", weight: 30 },
      },
    ],
  };

  /** The formatted run for one ordinal, as `isAdmin` would see it. */
  function runAt(ordinal: number, isAdmin: boolean) {
    const run = formatAttemptResponse(attempt, isAdmin).runs.find(
      (r: any) => r.ordinal === ordinal
    );
    if (!run) throw new Error(`no formatted run with ordinal ${ordinal}`);
    return run;
  }

  it("orders runs by test-case ordinal regardless of how they were loaded", () => {
    const out = formatAttemptResponse(attempt, false);
    expect(out.runs.map((r: any) => r.ordinal)).toEqual([1, 2]);
  });

  it("hides hidden-case input, expectation and output from a candidate", () => {
    const hidden = runAt(2, false);

    expect(hidden.stdin).toBeNull();
    expect(hidden.expectedOutput).toBeNull();
    expect(hidden.stdout).toBeNull();
    expect(hidden.stderr).toBeNull();
    // The verdict itself is not a secret — only the data behind it.
    expect(hidden.statusId).toBe(JUDGE0_WRONG_ANSWER);
    expect(hidden.kind).toBe("hidden");
  });

  it("shows sample cases to a candidate", () => {
    const sample = runAt(1, false);

    expect(sample.stdin).toBe("1\n");
    expect(sample.expectedOutput).toBe("1\n");
    expect(sample.stdout).toBe("ok\n");
  });

  it("shows everything to an admin", () => {
    const hidden = runAt(2, true);

    expect(hidden.stdin).toBe("secret in\n");
    expect(hidden.expectedOutput).toBe("secret out\n");
    expect(hidden.stdout).toBe("wrong\n");
    expect(hidden.stderr).toBe("boom\n");
  });

  it("never leaks per-case weights or raw test-case ids", () => {
    const serialized = JSON.stringify(formatAttemptResponse(attempt, false));

    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("weight");
  });

  it("does not mutate the attempt it was given", () => {
    const runOrder = attempt.runs.map((r) => r.id);
    formatAttemptResponse(attempt, false);
    expect(attempt.runs.map((r) => r.id)).toEqual(runOrder);
  });
});
