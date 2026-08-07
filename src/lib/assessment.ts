import crypto from "crypto";
import type { Problem, TestCase } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { pollAndScoreAttempt } from "@/lib/grading";
import {
  HEARTBEAT_MS,
  MAX_OFFLINE_CREDIT_MS,
  OFFLINE_CREDIT_MIN_MS,
} from "@/lib/proctor-config";

export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

/** The token in a test's shared link. Unguessable, so the link is the gate. */
export function generateJoinToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function testUrl(joinToken: string): string {
  return `${BASE_URL.replace(/\/$/, "")}/t/${joinToken}`;
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
 * Always read through here rather than through `assessment.problems`: the
 * assessment's set is live and an admin may edit it mid-test, whereas the
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
      assessment: {
        select: {
          problems: { include: { problem: withCases }, orderBy: { ordinal: "asc" } },
        },
      },
    },
  });

  return (session?.assessment.problems ?? []).map((ap) => ({
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
 * Time the candidate actually had, capped at their deadline.
 *
 * A run that was never submitted from the candidate's side is only stamped when
 * a sweep notices, so the raw difference grows until someone opens an admin
 * page. Nobody can work past the buzzer, so the deadline is the ceiling.
 */
export function sessionElapsedMs(
  s: { startedAt: Date; submittedAt: Date | null; endsAt: Date },
  now = Date.now()
): number {
  const end = Math.min((s.submittedAt ?? new Date(now)).getTime(), s.endsAt.getTime());
  return Math.max(0, end - s.startedAt.getTime());
}

export interface SessionScoreSummary {
  /** Points earned per question, keyed by problemId. */
  perProblem: Record<string, number>;
  totalScore: number;
  maxScore: number;
  solvedCount: number;
  questionCount: number;
  submissionCount: number;
}

/**
 * Score any number of sessions in three queries, whichever tests they belong to.
 *
 * `computeSessionScore` is the same rule for one session and costs a round-trip
 * per call, which is fine on a session page and quadratic on a dashboard listing
 * every candidate. Returns one entry per input session, so callers can index the
 * map without a null check.
 *
 * Scores are computed rather than read from `TestSession.totalScore`, which is
 * only written at finalization — a candidate still working would otherwise sit
 * at zero for the whole test. The two agree once a run ends.
 */
export async function summarizeSessions(
  sessions: { id: string; assessmentId: string }[]
): Promise<Map<string, SessionScoreSummary>> {
  const out = new Map<string, SessionScoreSummary>();
  if (sessions.length === 0) return out;

  const sessionIds = sessions.map((s) => s.id);
  const assessmentIds = Array.from(new Set(sessions.map((s) => s.assessmentId)));

  const [served, liveSets, attempts] = await Promise.all([
    prisma.sessionProblem.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, problemId: true, points: true, ordinal: true },
      orderBy: { ordinal: "asc" },
    }),
    // Fallback for sessions that predate the snapshot, matching loadSessionProblems.
    prisma.assessmentProblem.findMany({
      where: { assessmentId: { in: assessmentIds } },
      select: { assessmentId: true, problemId: true, points: true, ordinal: true },
      orderBy: { ordinal: "asc" },
    }),
    prisma.attempt.findMany({
      where: { sessionId: { in: sessionIds }, kind: "submit", state: "done" },
      select: { sessionId: true, problemId: true, score: true, maxScore: true },
    }),
  ]);

  const servedBySession = new Map<string, { problemId: string; points: number }[]>();
  for (const sp of served) {
    const list = servedBySession.get(sp.sessionId) ?? [];
    list.push({ problemId: sp.problemId, points: sp.points });
    servedBySession.set(sp.sessionId, list);
  }

  const setByAssessment = new Map<string, { problemId: string; points: number }[]>();
  for (const ap of liveSets) {
    const list = setByAssessment.get(ap.assessmentId) ?? [];
    list.push({ problemId: ap.problemId, points: ap.points });
    setByAssessment.set(ap.assessmentId, list);
  }

  // Best ratio per (session, problem) — retrying near the buzzer can only help.
  const bestRatio = new Map<string, number>();
  const submissionCounts = new Map<string, number>();
  for (const a of attempts) {
    if (!a.sessionId) continue;
    const key = `${a.sessionId}:${a.problemId}`;
    const ratio = a.maxScore > 0 ? a.score / a.maxScore : 0;
    bestRatio.set(key, Math.max(bestRatio.get(key) ?? 0, ratio));
    submissionCounts.set(a.sessionId, (submissionCounts.get(a.sessionId) ?? 0) + 1);
  }

  for (const s of sessions) {
    const mine = servedBySession.get(s.id) ?? setByAssessment.get(s.assessmentId) ?? [];

    const perProblem: Record<string, number> = {};
    let totalScore = 0;
    let maxScore = 0;
    let solvedCount = 0;

    for (const sp of mine) {
      const ratio = bestRatio.get(`${s.id}:${sp.problemId}`) ?? 0;
      const earned = Math.round(ratio * sp.points);
      perProblem[sp.problemId] = earned;
      totalScore += earned;
      maxScore += sp.points;
      if (ratio >= 1) solvedCount += 1;
    }

    out.set(s.id, {
      perProblem,
      totalScore,
      maxScore,
      solvedCount,
      questionCount: mine.length,
      submissionCount: submissionCounts.get(s.id) ?? 0,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Offline credit
//
// The clock is wall-clock and server-side, so an outage costs a candidate real
// working time through no fault of their own. Time spent offline is given back by
// pushing `endsAt` forward, up to a per-session cap — effectively a pause: a
// candidate who drops off with ten minutes left comes back with ten minutes left.
//
// Bounded on purpose, in three ways. Nobody gets back more time than they had
// when they dropped; a session with nothing left is owed nothing; and no session
// is ever extended by more than MAX_OFFLINE_CREDIT_MS in total, however many
// outages it takes. Every grant is recorded on the session and shown on the
// report, because "my connection went" is also what abuse looks like.
// ---------------------------------------------------------------------------

/** Credit this session has not spent yet. */
export function remainingCreditMs(s: { creditedMs: number }): number {
  return Math.max(0, MAX_OFFLINE_CREDIT_MS - s.creditedMs);
}

interface CreditableSession {
  id: string;
  endsAt: Date;
  lastSeenAt: Date;
  creditedMs: number;
}

/**
 * How much time this session is owed for being offline: what it takes to put the
 * candidate back where the outage found them.
 *
 * Two guards do the work. The outage starts at the beat the candidate was expected
 * to send rather than their last one, so the normal quiet between heartbeats is
 * never credited. And it is only an outage at all if there was time left on their
 * clock when it began — a tab closed at the buzzer is owed nothing, however long
 * it stays closed, so waiting out the clock and coming back cannot buy a reprieve.
 *
 * Given both, the whole outage is returned: pushing `endsAt` forward by the time
 * they were away leaves exactly the time they had. It cannot hand back more than
 * that — someone who drops with twenty seconds left gets twenty seconds — and the
 * per-session budget is the ceiling on all of it.
 */
export function pendingOfflineCreditMs(s: CreditableSession, now = Date.now()): number {
  if (now - s.lastSeenAt.getTime() < OFFLINE_CREDIT_MIN_MS) return 0;

  const outageStart = s.lastSeenAt.getTime() + HEARTBEAT_MS;
  if (s.endsAt.getTime() <= outageStart) return 0;

  return Math.min(now - outageStart, remainingCreditMs(s));
}

/**
 * Give back the time this session spent offline, and return the session as it now
 * stands. A no-op when nothing is owed, which is the common case.
 *
 * Called from `requireLiveSession`, so any request the candidate makes on
 * reconnecting collects the credit — including one that arrives after their
 * original deadline, which is the case that matters most: an outage that spanned
 * the buzzer must not end a test they were entitled to finish.
 */
export async function applyOfflineCredit<T extends CreditableSession>(
  session: T,
  now = Date.now()
): Promise<{ session: T; grantedMs: number }> {
  const grant = pendingOfflineCreditMs(session, now);
  if (grant <= 0) return { session, grantedMs: 0 };

  // Claim the grant on the `lastSeenAt` it was computed from. Two requests
  // arriving together after the same outage would otherwise each extend the
  // deadline by the full gap, doubling the credit.
  const claimed = await prisma.testSession.updateMany({
    where: { id: session.id, state: "in_progress", lastSeenAt: session.lastSeenAt },
    data: {
      endsAt: new Date(session.endsAt.getTime() + grant),
      creditedMs: session.creditedMs + grant,
      lastSeenAt: new Date(now),
    },
  });

  if (claimed.count === 0) {
    // Someone else got there first; take their numbers rather than this stale copy.
    const fresh = await prisma.testSession.findUnique({
      where: { id: session.id },
      select: { endsAt: true, creditedMs: true, lastSeenAt: true },
    });
    return { session: fresh ? ({ ...session, ...fresh } as T) : session, grantedMs: 0 };
  }

  return {
    session: {
      ...session,
      endsAt: new Date(session.endsAt.getTime() + grant),
      creditedMs: session.creditedMs + grant,
      lastSeenAt: new Date(now),
    } as T,
    grantedMs: grant,
  };
}

/** End a session for good: drain any in-flight grading and freeze the score. */
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

  return prisma.testSession.update({
    where: { id: sessionId },
    data: { totalScore, maxScore },
  });
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
  const now = Date.now();

  // Over-fetched because some rows are skipped below: a session being held for
  // its offline credit must not occupy one of the batch's slots and starve the
  // sessions behind it.
  const expired = await prisma.testSession.findMany({
    where: { state: "in_progress", endsAt: { lt: new Date(now) } },
    orderBy: { endsAt: "asc" },
    take: limit * 3,
    select: { id: true, endsAt: true, lastSeenAt: true, creditedMs: true },
  });

  // A candidate who dropped off before their buzzer is owed that time back the
  // moment they reconnect, so finalizing them as the clock passes would end a
  // test they can still resume. Held only until the credit they are owed has
  // itself run out — a tab closed while online is owed nothing and goes now.
  const ripe = expired
    .filter((s) => s.endsAt.getTime() + pendingOfflineCreditMs(s, now) <= now)
    .slice(0, limit);

  // Best effort; the next sweep retries whatever failed or did not fit.
  const settled = await Promise.allSettled(
    ripe.map((s) => finalizeSession(s.id, "auto_submitted"))
  );
  return settled.filter((r) => r.status === "fulfilled").length;
}

export function remainingMs(endsAt: Date): number {
  return Math.max(0, endsAt.getTime() - Date.now());
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardQuestion {
  problemId: string;
  ordinal: number;
  title: string;
  points: number;
}

export interface LeaderboardRow {
  rank: number;
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  image: string | null;
  state: string;
  totalScore: number;
  maxScore: number;
  /** Points earned per question, keyed by problemId. Missing = never attempted. */
  perProblem: Record<string, number>;
  solvedCount: number;
  submissionCount: number;
  violationCount: number;
  startedAt: Date;
  submittedAt: Date | null;
  elapsedMs: number;
  /** Time added back for being offline, so a long run has an explanation. */
  creditedMs: number;
  /** Still sitting the test — the score below them is a running total. */
  live: boolean;
}

/**
 * Every candidate who has taken a test, ranked.
 *
 * Scores are recomputed here rather than read from `TestSession.totalScore`,
 * which is only written at finalization: a candidate still working would
 * otherwise sit at zero for the whole test. The frozen column and this
 * computation agree once a session ends, since both run the same best-per-
 * problem rule from `computeSessionScore`.
 *
 * Three queries regardless of how many candidates there are — the per-session
 * loop in `computeSessionScore` would be one round-trip per row.
 */
export async function buildLeaderboard(assessmentId: string) {
  const [assessment, sessions] = await Promise.all([
    prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: { problems: { include: { problem: true }, orderBy: { ordinal: "asc" } } },
    }),
    prisma.testSession.findMany({
      where: { assessmentId },
      include: { user: { select: { image: true } } },
    }),
  ]);

  if (!assessment) return null;

  const summaries = await summarizeSessions(
    sessions.map((s) => ({ id: s.id, assessmentId: s.assessmentId }))
  );

  // Columns come from the assessment's current question list, so the table has a
  // stable shape. A candidate served a question that has since been removed still
  // has it counted in their total; it just has no column of its own.
  const questions: LeaderboardQuestion[] = assessment.problems.map((ap) => ({
    problemId: ap.problemId,
    ordinal: ap.ordinal,
    title: ap.problem.title,
    points: ap.points,
  }));

  // One timestamp for the whole table, so live rows are all measured against the
  // same instant rather than drifting apart row by row.
  const now = Date.now();

  const rows = sessions.map((s) => {
    const sum = summaries.get(s.id)!;
    return {
      sessionId: s.id,
      candidateName: s.candidateName,
      candidateEmail: s.candidateEmail,
      image: s.user?.image ?? null,
      state: s.state,
      totalScore: sum.totalScore,
      maxScore: sum.maxScore,
      perProblem: sum.perProblem,
      solvedCount: sum.solvedCount,
      submissionCount: sum.submissionCount,
      violationCount: s.violationCount,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      elapsedMs: sessionElapsedMs(s, now),
      creditedMs: s.creditedMs,
      live: s.state === "in_progress",
    };
  });

  // Score first, then whoever got there faster. Candidates still working are
  // ranked alongside everyone else on their running total, and flagged `live` so
  // the table can say that their position is not final.
  //
  // The speed comparison discounts time credited back for an outage: a candidate
  // sat waiting for their connection was not working, and the whole point of
  // giving that time back is that losing it costs them nothing. `elapsedMs` is
  // still what the table shows — that is the window they occupied.
  const worked = (r: { elapsedMs: number; creditedMs: number }) =>
    Math.max(0, r.elapsedMs - r.creditedMs);

  rows.sort((a, b) => b.totalScore - a.totalScore || worked(a) - worked(b));

  // Equal score and equal time is a genuine tie, so it shares a rank; the next
  // candidate down then skips to their true position (1, 2, 2, 4).
  const ranked: LeaderboardRow[] = [];
  rows.forEach((r, i) => {
    const prev = ranked[i - 1];
    const tied = prev && prev.totalScore === r.totalScore && worked(prev) === worked(r);
    ranked.push({ ...r, rank: tied ? prev.rank : i + 1 });
  });

  return {
    assessment: {
      id: assessment.id,
      title: assessment.title,
      durationMinutes: assessment.durationMinutes,
      maxViolations: assessment.maxViolations,
      isActive: assessment.isActive,
      totalPoints: questions.reduce((s, q) => s + q.points, 0),
    },
    questions,
    rows: ranked,
  };
}
