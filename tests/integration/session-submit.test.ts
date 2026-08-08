// Exercises the two real modules a proctored submission passes through:
// requireLiveSession (ownership, liveness, the clock) and the session submit
// route (payload validation, draft persistence, dispatch to grading).
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, because vi.mock factories are lifted above every other statement
// in the file and cannot close over ordinary top-level consts.
const h = vi.hoisted(() => ({
  prisma: {
    testSession: { findUnique: vi.fn() },
    sessionDraft: { upsert: vi.fn() },
  },
  getServerSession: vi.fn(),
  applyOfflineCredit: vi.fn(),
  finalizeSession: vi.fn(),
  loadSessionProblems: vi.fn(),
  createAttempt: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("next-auth", () => ({ getServerSession: h.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/assessment", () => ({
  applyOfflineCredit: h.applyOfflineCredit,
  finalizeSession: h.finalizeSession,
  loadSessionProblems: h.loadSessionProblems,
}));
vi.mock("@/lib/grading", () => ({ createAttempt: h.createAttempt }));

const {
  prisma: mockPrisma,
  getServerSession,
  applyOfflineCredit,
  finalizeSession,
  loadSessionProblems,
  createAttempt,
} = h;

// Imported after the mocks so the modules under test pick them up.
import { requireLiveSession } from "@/lib/session-guard";
import { POST } from "@/app/api/session/[id]/submit/route";

const SESSION_ID = "sess-123";
const PROBLEM_ID = "prob-1";
const USER_ID = "user-1";

const problem = {
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

const sessionProblems = [{ problemId: PROBLEM_ID, ordinal: 1, points: 100, problem }];

function liveSession(over: Record<string, any> = {}) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    state: "in_progress",
    endsAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
    creditedMs: 0,
    assessment: { id: "assess-1", title: "Test Assessment", maxViolations: 5 },
    ...over,
  };
}

function post(body: unknown, id = SESSION_ID) {
  const req = new Request(`http://localhost/api/session/${id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req as any, { params: { id } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: { id: USER_ID, email: "a@b.com" } });
  mockPrisma.testSession.findUnique.mockResolvedValue(liveSession());
  mockPrisma.sessionDraft.upsert.mockResolvedValue({});
  // Nothing owed is the common case; the credit rules themselves are covered in
  // tests/unit/offline-credit.test.ts.
  applyOfflineCredit.mockImplementation((s: any) => Promise.resolve({ session: s, grantedMs: 0 }));
  loadSessionProblems.mockResolvedValue(sessionProblems);
  createAttempt.mockResolvedValue("attempt-1");
});

describe("requireLiveSession", () => {
  it("401s an unauthenticated caller without looking the session up", async () => {
    getServerSession.mockResolvedValue(null);

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error?.status).toBe(401);
    expect(mockPrisma.testSession.findUnique).not.toHaveBeenCalled();
  });

  it("404s a session that does not exist", async () => {
    mockPrisma.testSession.findUnique.mockResolvedValue(null);

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error?.status).toBe(404);
  });

  it("403s a session belonging to somebody else", async () => {
    mockPrisma.testSession.findUnique.mockResolvedValue(liveSession({ userId: "user-other" }));

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error?.status).toBe(403);
    expect(await guard.error!.json()).toEqual({ error: "Forbidden" });
  });

  it("409s an already-submitted session and reports the state it ended in", async () => {
    mockPrisma.testSession.findUnique.mockResolvedValue(liveSession({ state: "submitted" }));

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error?.status).toBe(409);
    expect(await guard.error!.json()).toEqual({
      error: "This test has ended",
      state: "submitted",
      ended: true,
    });
    // Already finished — nothing to finalize again.
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it("409s and auto-submits a session found past its deadline", async () => {
    mockPrisma.testSession.findUnique.mockResolvedValue(
      liveSession({ endsAt: new Date(Date.now() - 1_000) })
    );

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error?.status).toBe(409);
    expect(await guard.error!.json()).toEqual({
      error: "Time is up",
      state: "auto_submitted",
      ended: true,
    });
    expect(finalizeSession).toHaveBeenCalledWith(SESSION_ID, "auto_submitted");
  });

  it("credits time back before judging the clock, so a reconnection is not fatal", async () => {
    // Expired on the stored row, still alive once the outage is paid back.
    const expired = liveSession({ endsAt: new Date(Date.now() - 30_000) });
    mockPrisma.testSession.findUnique.mockResolvedValue(expired);
    applyOfflineCredit.mockResolvedValue({
      session: { ...expired, endsAt: new Date(Date.now() + 60_000) },
      grantedMs: 90_000,
    });

    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error).toBeUndefined();
    expect(guard.grantedMs).toBe(90_000);
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it("returns the session's frozen problem set, not the assessment's live one", async () => {
    const guard = await requireLiveSession(SESSION_ID);

    expect(guard.error).toBeUndefined();
    expect(loadSessionProblems).toHaveBeenCalledWith(SESSION_ID);
    expect(guard.problems).toEqual(sessionProblems);
    expect(guard.userId).toBe(USER_ID);
  });
});

describe("POST /api/session/[id]/submit", () => {
  it("passes the guard's rejection straight through", async () => {
    getServerSession.mockResolvedValue(null);

    const res = await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "x" });

    expect(res.status).toBe(401);
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("400s a malformed body", async () => {
    const res = await post("not json at all");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing fields" });
  });

  it("400s a missing problemId or languageId", async () => {
    const noProblem = await post({ languageId: 71, sourceCode: "x" });
    const noLang = await post({ problemId: PROBLEM_ID, sourceCode: "x" });

    expect(noProblem.status).toBe(400);
    expect(noLang.status).toBe(400);
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("400s a non-string sourceCode", async () => {
    const res = await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: 42 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing fields" });
  });

  it("400s whitespace-only code with its own message", async () => {
    const res = await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "   \n\t " });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Write some code first" });
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("400s a problem the session was not served", async () => {
    const res = await post({ problemId: "prob-elsewhere", languageId: 71, sourceCode: "x" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Problem not in this test" });
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("400s a language the problem does not allow", async () => {
    const res = await post({ problemId: PROBLEM_ID, languageId: 63, sourceCode: "x" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Language not allowed for this problem" });
    expect(createAttempt).not.toHaveBeenCalled();
  });

  it("dispatches an allowed submission and returns the attempt id", async () => {
    const res = await post({
      problemId: PROBLEM_ID,
      languageId: 71,
      sourceCode: "print(1)",
      kind: "submit",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attemptId: "attempt-1" });
    expect(createAttempt).toHaveBeenCalledWith({
      userId: USER_ID,
      problem,
      languageId: 71,
      sourceCode: "print(1)",
      kind: "submit",
      sessionId: SESSION_ID,
    });
  });

  it("honours kind 'run' and treats anything else as a submit", async () => {
    await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "x", kind: "run" });
    expect(createAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "run" }));

    await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "x", kind: "nonsense" });
    expect(createAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "submit" }));

    await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "x" });
    expect(createAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "submit" }));
  });

  it("persists the draft so a crash right after submitting loses nothing", async () => {
    await post({ problemId: PROBLEM_ID, languageId: 62, sourceCode: "class Main {}" });

    expect(mockPrisma.sessionDraft.upsert).toHaveBeenCalledWith({
      where: { sessionId_problemId: { sessionId: SESSION_ID, problemId: PROBLEM_ID } },
      create: { sessionId: SESSION_ID, problemId: PROBLEM_ID, languageId: 62, code: "class Main {}" },
      update: { languageId: 62, code: "class Main {}" },
    });
  });

  it("500s with the grading error's message when dispatch fails", async () => {
    createAttempt.mockRejectedValue(new Error("This problem has no sample cases to run"));

    const res = await post({ problemId: PROBLEM_ID, languageId: 71, sourceCode: "x", kind: "run" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "This problem has no sample cases to run" });
  });
});
