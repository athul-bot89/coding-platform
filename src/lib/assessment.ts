import crypto from "crypto";
import type { Problem, TestCase } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { pollAndScoreAttempt } from "@/lib/grading";
import { INVITE_VALID_DAYS } from "@/lib/proctor-config";

export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

export function generateInviteToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function inviteUrl(token: string): string {
  return `${BASE_URL.replace(/\/$/, "")}/invite/${token}`;
}

export function defaultInviteExpiry(days = INVITE_VALID_DAYS): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** Emails are compared case-insensitively — Google hands back varying casing. */
export function emailsMatch(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type SessionEndState = "submitted" | "auto_submitted" | "terminated";

/** One question as it was served to a session, with everything needed to run it. */
export interface SessionProblemView {
  problemId: string;
  ordinal: number;
  points: number;
  problem: Problem & { testCases: TestCase[] };
}

/**
 * The problem set a session is entitled to, ordered as the candidate sees it.
 *
 * Always read through here rather than through `invitation.assessment.problems`:
 * the assessment's set is live and an admin may edit it mid-test, whereas the
 * SessionProblem snapshot is what the candidate was actually given. Sessions
 * that predate the snapshot have no rows and fall back to the live set, which is
 * the best that can be reconstructed for them.
 */
export async function loadSessionProblems(sessionId: string): Promise<SessionProblemView[]> {
  const withCases = { include: { testCases: { orderBy: { ordinal: "asc" } } } } as const;

  const frozen = await prisma.sessionProblem.findMany({
    where: { sessionId },
    include: { problem: withCases },
    orderBy: { ordinal: "asc" },
  });

  if (frozen.length > 0) {
    return frozen.map((sp) => ({
      problemId: sp.problemId,
      ordinal: sp.ordinal,
      points: sp.points,
      problem: sp.problem,
    }));
  }

  const session = await prisma.testSession.findUnique({
    where: { id: sessionId },
    select: {
      invitation: {
        select: {
          assessment: {
            select: {
              problems: { include: { problem: withCases }, orderBy: { ordinal: "asc" } },
            },
          },
        },
      },
    },
  });

  return (session?.invitation.assessment.problems ?? []).map((ap) => ({
    problemId: ap.problemId,
    ordinal: ap.ordinal,
    points: ap.points,
    problem: ap.problem,
  }));
}

/**
 * Best score per problem, scaled to that problem's point value.
 *
 * Only `kind: "submit"` attempts count — sample "run"s are practice. Taking the
 * best rather than the last means a candidate can never lose points by trying
 * again near the buzzer. Scoring runs over the session's frozen problem set, so
 * work stays credited even if the assessment has since been edited.
 */
export async function computeSessionScore(sessionId: string) {
  const problems = await loadSessionProblems(sessionId);
  if (problems.length === 0) {
    return { totalScore: 0, maxScore: 0, perProblem: [] as PerProblemScore[] };
  }

  const attempts = await prisma.attempt.findMany({
    where: { sessionId, kind: "submit", state: "done" },
    select: { problemId: true, score: true, maxScore: true },
  });

  const perProblem: PerProblemScore[] = problems.map((sp) => {
    const mine = attempts.filter((a) => a.problemId === sp.problemId);
    const bestRatio = mine.reduce(
      (best, a) => Math.max(best, a.maxScore > 0 ? a.score / a.maxScore : 0),
      0
    );
    return {
      problemId: sp.problemId,
      ordinal: sp.ordinal,
      points: sp.points,
      earned: Math.round(bestRatio * sp.points),
      ratio: bestRatio,
      submissions: mine.length,
    };
  });

  return {
    totalScore: perProblem.reduce((s, p) => s + p.earned, 0),
    maxScore: perProblem.reduce((s, p) => s + p.points, 0),
    perProblem,
  };
}

export interface PerProblemScore {
  problemId: string;
  ordinal: number;
  points: number;
  earned: number;
  ratio: number;
  submissions: number;
}

/**
 * End a session for good: drain any in-flight grading, freeze the score, and
 * mirror the outcome onto the invitation so the link stops working.
 */
export async function finalizeSession(sessionId: string, state: SessionEndState) {
  const existing = await prisma.testSession.findUnique({ where: { id: sessionId } });
  if (!existing || existing.state !== "in_progress") return existing;

  // The moment the test really ended. A session whose clock ran out is credited
  // with time up to its deadline, not up to whenever a sweep noticed — otherwise
  // an abandoned test reports a duration that grows until someone opens it.
  const submittedAt = new Date(Math.min(Date.now(), existing.endsAt.getTime()));

  // Claim the transition rather than trusting the read above. Exactly one caller
  // can move a session out of "in_progress", so a sweep racing the candidate's
  // own Finish cannot overwrite their real submission (or vice versa).
  const claimed = await prisma.testSession.updateMany({
    where: { id: sessionId, state: "in_progress" },
    data: { state, submittedAt },
  });
  if (claimed.count === 0) {
    return prisma.testSession.findUnique({ where: { id: sessionId } });
  }

  // Grade anything still mid-flight so a buzzer-beating submit still counts.
  // This is the last chance to poll these attempts — nothing revisits a session
  // once it is out of "in_progress" — so it happens here rather than being left
  // to a later pass. Concurrently, because every poll is a Judge0 round-trip and
  // a caller is waiting; a stuck attempt must not hold up finalization either.
  const pending = await prisma.attempt.findMany({
    where: { sessionId, state: "running" },
    select: { id: true },
  });
  await Promise.allSettled(pending.map((a) => pollAndScoreAttempt(a.id)));

  const { totalScore, maxScore } = await computeSessionScore(sessionId);

  const updated = await prisma.testSession.update({
    where: { id: sessionId },
    data: { totalScore, maxScore },
  });

  await prisma.invitation.update({
    where: { id: updated.invitationId },
    data: { status: state === "terminated" ? "terminated" : "submitted" },
  });

  return updated;
}

/** How many expired sessions one sweep finalizes; the rest wait for the next. */
const SWEEP_BATCH = 10;

/**
 * Finalize sessions whose clock ran out while nobody was watching — a candidate
 * who closes their laptop still gets scored. Called from session reads and the
 * admin list endpoints.
 *
 * Riding on reads is a stopgap, which is why the batch is capped and the
 * finalizations run concurrently: each one costs a Judge0 round-trip per attempt
 * still being graded, and a backlog of finished candidates must not turn an admin
 * page load into an unbounded wait. A scheduled job is the real home for this —
 * it would finalize on time rather than whenever an admin happens to look, and
 * would need no cap at all.
 */
export async function sweepExpiredSessions(limit = SWEEP_BATCH) {
  const expired = await prisma.testSession.findMany({
    where: { state: "in_progress", endsAt: { lt: new Date() } },
    orderBy: { endsAt: "asc" },
    take: limit,
    select: { id: true },
  });

  // Best effort; the next sweep retries whatever failed or did not fit.
  const settled = await Promise.allSettled(
    expired.map((s) => finalizeSession(s.id, "auto_submitted"))
  );
  return settled.filter((r) => r.status === "fulfilled").length;
}

/** Also expire invitations whose window passed before anyone opened them. */
export async function sweepExpiredInvitations() {
  await prisma.invitation.updateMany({
    where: { status: "pending", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
}

export function remainingMs(endsAt: Date): number {
  return Math.max(0, endsAt.getTime() - Date.now());
}
