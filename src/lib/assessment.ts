import crypto from "crypto";
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

/**
 * Best score per problem, scaled to that problem's point value.
 *
 * Only `kind: "submit"` attempts count — sample "run"s are practice. Taking the
 * best rather than the last means a candidate can never lose points by trying
 * again near the buzzer.
 */
export async function computeSessionScore(sessionId: string) {
  const session = await prisma.testSession.findUnique({
    where: { id: sessionId },
    include: { invitation: { include: { assessment: { include: { problems: true } } } } },
  });
  if (!session) return { totalScore: 0, maxScore: 0, perProblem: [] as PerProblemScore[] };

  const problems = session.invitation.assessment.problems;
  const attempts = await prisma.attempt.findMany({
    where: { sessionId, kind: "submit", state: "done" },
    select: { problemId: true, score: true, maxScore: true },
  });

  const perProblem: PerProblemScore[] = problems
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((ap) => {
      const mine = attempts.filter((a) => a.problemId === ap.problemId);
      const bestRatio = mine.reduce(
        (best, a) => Math.max(best, a.maxScore > 0 ? a.score / a.maxScore : 0),
        0
      );
      return {
        problemId: ap.problemId,
        ordinal: ap.ordinal,
        points: ap.points,
        earned: Math.round(bestRatio * ap.points),
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

  // Grade anything still mid-flight so a buzzer-beating submit still counts.
  const pending = await prisma.attempt.findMany({
    where: { sessionId, state: "running" },
    select: { id: true },
  });
  for (const a of pending) {
    try {
      await pollAndScoreAttempt(a.id);
    } catch {
      // A stuck attempt must not block finalization.
    }
  }

  const { totalScore, maxScore } = await computeSessionScore(sessionId);

  const updated = await prisma.testSession.update({
    where: { id: sessionId },
    data: { state, submittedAt: new Date(), totalScore, maxScore },
  });

  await prisma.invitation.update({
    where: { id: updated.invitationId },
    data: { status: state === "terminated" ? "terminated" : "submitted" },
  });

  return updated;
}

/**
 * Finalize sessions whose clock ran out while nobody was watching — a candidate
 * who closes their laptop still gets scored. Called from session reads and the
 * admin list endpoints, which removes the need for a cron job.
 */
export async function sweepExpiredSessions() {
  const expired = await prisma.testSession.findMany({
    where: { state: "in_progress", endsAt: { lt: new Date() } },
    select: { id: true },
  });

  for (const s of expired) {
    try {
      await finalizeSession(s.id, "auto_submitted");
    } catch {
      // Best effort; the next sweep retries.
    }
  }
  return expired.length;
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
