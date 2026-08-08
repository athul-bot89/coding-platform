import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock Prisma (factory-based to avoid hoisting issues) ----
vi.mock("@/lib/prisma", () => ({
  prisma: {
    testSession: { count: vi.fn() },
    problem: { findFirst: vi.fn() },
    attempt: { create: vi.fn(), update: vi.fn() },
    attemptRun: { createMany: vi.fn() },
  },
}));

// ---- Mock Judge0 ----
vi.mock("@/lib/judge0", () => ({
  createBatchSubmissions: vi.fn(),
  getBatchSubmissions: vi.fn(),
  isTerminal: vi.fn(),
}));

// ---- Mock auth ----
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(() => Promise.resolve({ user: { id: "admin-1", email: "admin@test.com" } })),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/admin-guard", () => ({
  requireAdmin: vi.fn(() => Promise.resolve({ userId: "admin-1" })),
}));

import { createAttempt } from "@/lib/grading";
import { prisma } from "@/lib/prisma";
import { createBatchSubmissions } from "@/lib/judge0";

const mockPrisma = vi.mocked(prisma);
const mockCreateBatch = vi.mocked(createBatchSubmissions);

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
});
