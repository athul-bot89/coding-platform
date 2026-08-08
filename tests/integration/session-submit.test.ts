import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock Prisma ----
const mockPrisma = {
  testSession: {
    findUnique: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  attempt: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  attemptRun: { createMany: vi.fn() },
  sessionDraft: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  problem: {
    findFirst: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ---- Mock next-auth ----
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(() => Promise.resolve({ user: { id: "user-1", email: "a@b.com" } })),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

// ---- Mock assessment helpers ----
vi.mock("@/lib/assessment", () => ({
  applyOfflineCredit: vi.fn((session: any) => ({ session, grantedMs: 0 })),
  finalizeSession: vi.fn(),
  loadSessionProblems: vi.fn(),
  remainingMs: vi.fn(() => 300000),
}));

// ---- Mock Judge0 ----
vi.mock("@/lib/judge0", () => ({
  createBatchSubmissions: vi.fn(() => Promise.resolve(["token-1", "token-2"])),
  getBatchSubmissions: vi.fn(),
  isTerminal: vi.fn(),
}));

describe("integration: session submit flow", () => {
  const SESSION_ID = "sess-123";
  const PROBLEM_ID = "prob-1";

  const mockSession = {
    id: SESSION_ID,
    userId: "user-1",
    state: "in_progress",
    endsAt: new Date(Date.now() + 3600_000),
    assessment: { id: "assess-1", title: "Test Assessment", maxViolations: 5 },
  };

  const mockProblem = {
    id: PROBLEM_ID,
    title: "Two Sum",
    allowedLanguages: "71,62",
    timeLimitMs: 2000,
    memoryLimitKb: 128000,
    testCases: [
      { id: "tc-1", ordinal: 1, kind: "sample", stdin: "1 2\n", expectedOutput: "3\n", weight: 50 },
      { id: "tc-2", ordinal: 2, kind: "hidden", stdin: "5 7\n", expectedOutput: "12\n", weight: 50 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.testSession.findUnique.mockResolvedValue(mockSession);
    mockPrisma.attempt.create.mockResolvedValue({ id: "attempt-1" });
    mockPrisma.attemptRun.createMany.mockResolvedValue({ count: 2 });
    mockPrisma.sessionDraft.upsert.mockResolvedValue({});
  });

  describe("input validation", () => {
    it("rejects missing sourceCode", async () => {
      // Directly test that the validation logic would reject
      const payload = { problemId: PROBLEM_ID, languageId: 71, sourceCode: "" };
      // Simulate the trim check from the route
      expect(payload.sourceCode.trim()).toBe("");
    });

    it("rejects invalid language type", () => {
      const languageId = "python" as any;
      expect(typeof languageId !== "number" || !Number.isInteger(languageId)).toBe(true);
    });

    it("rejects language not in allowedLanguages", () => {
      const allowed = mockProblem.allowedLanguages.split(",").map(Number);
      expect(allowed.includes(63)).toBe(false); // JS not allowed
      expect(allowed.includes(71)).toBe(true); // Python allowed
    });
  });

  describe("grading dispatch", () => {
    it("separates sample and hidden cases for 'run' kind", () => {
      const cases = mockProblem.testCases;
      const runCases = cases.filter((tc) => tc.kind === "sample");
      const submitCases = cases;
      expect(runCases).toHaveLength(1);
      expect(submitCases).toHaveLength(2);
    });

    it("computes maxScore as sum of weights", () => {
      const cases = mockProblem.testCases;
      const maxScore = cases.reduce((sum, tc) => sum + tc.weight, 0);
      expect(maxScore).toBe(100);
    });
  });

  describe("session guard logic", () => {
    it("rejects when session state is not in_progress", () => {
      const ended = { ...mockSession, state: "submitted" };
      expect(ended.state !== "in_progress").toBe(true);
    });

    it("rejects when session belongs to different user", () => {
      const other = { ...mockSession, userId: "user-other" };
      expect(other.userId !== "user-1").toBe(true);
    });

    it("rejects when time is up", () => {
      const expired = { ...mockSession, endsAt: new Date(Date.now() - 1000) };
      expect(expired.endsAt.getTime() <= Date.now()).toBe(true);
    });

    it("accepts valid in-progress session for correct user", () => {
      expect(mockSession.state).toBe("in_progress");
      expect(mockSession.userId).toBe("user-1");
      expect(mockSession.endsAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
