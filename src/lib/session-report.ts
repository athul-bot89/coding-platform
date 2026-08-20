// Reconstructing where a candidate's time went.
//
// Nothing records which question was on screen. The schema has no per-question
// clock and TypingMetric.activeMs is not one either — it is the sum of the gaps
// between consecutive keystrokes, so a candidate who spent twenty minutes reading
// a problem and two minutes typing the answer scores two minutes there.
//
// What the schema does have is a scattering of timestamped, per-question facts:
// every Run, every Submit, the last draft save, every paste burst. Sorted into
// one series they say where the candidate was at those instants, and the gaps
// between them can be attributed to whoever they belong to. That is an estimate,
// and it is presented as one — but on real sessions it accounts for essentially
// the whole window, which no exact figure available here does.

import { isAccepted, isFailed, isPending } from "@/lib/judge0-status";

/**
 * The longest single gap that can be credited to a question.
 *
 * A gap is evidence the candidate was working on the question that closes it —
 * up to a point. Beyond a few minutes with nothing landing, the likelier reading
 * is that they were reading another problem, stuck, or away, so the excess is
 * counted as unattributed rather than billed to whatever they happened to touch
 * next. It also stops one marker from swallowing a whole abandoned test.
 */
export const IDLE_CAP_MS = 5 * 60_000;

/** One timestamped fact about a question, in ms since the session started. */
export interface ActivityMarker {
  problemId: string;
  atMs: number;
}

export interface QuestionTiming {
  problemId: string;
  /** Wall-clock time attributed to this question. Approximate by construction. */
  estimatedMs: number;
  /** First and last instants this question is known to have been worked on. */
  firstTouchMs: number | null;
  lastTouchMs: number | null;
  /** How many facts the estimate rests on — its resolution, and its credibility. */
  markers: number;
}

export interface TimeBreakdown {
  byProblem: Map<string, QuestionTiming>;
  /**
   * Time no question can be held responsible for: the tail of every gap longer
   * than the cap, plus the whole window of a session that produced no markers at
   * all. Large values mean the breakdown below it is thin, so it is reported
   * rather than quietly folded into the questions.
   */
  unattributedMs: number;
}

/**
 * Split a session's window across its questions.
 *
 * Gaps are credited *backwards* — to the question whose marker ends them. A run
 * on Q3 means the candidate was on Q3 in the run-up to it, which is where the
 * thinking time before a first attempt actually belongs; crediting forwards would
 * hand that time to whatever they had been doing before instead. The one gap with
 * no marker to close it is the tail after the last one, which goes forwards to
 * whatever was last worked on. Every gap is capped either way.
 */
export function buildTimeBreakdown(
  markers: ActivityMarker[],
  sessionDurationMs: number,
  idleCapMs = IDLE_CAP_MS
): TimeBreakdown {
  const byProblem = new Map<string, QuestionTiming>();

  const entry = (problemId: string): QuestionTiming => {
    let q = byProblem.get(problemId);
    if (!q) {
      q = { problemId, estimatedMs: 0, firstTouchMs: null, lastTouchMs: null, markers: 0 };
      byProblem.set(problemId, q);
    }
    return q;
  };

  // Markers arrive from four different tables, so they are neither sorted nor
  // guaranteed to sit inside the window: a burst carries a client-supplied
  // offset, and a draft saved during the finish request can land past the buzzer.
  const window = Math.max(0, sessionDurationMs);
  const sorted = markers
    .filter((m) => m.problemId && Number.isFinite(m.atMs))
    .map((m) => ({ problemId: m.problemId, atMs: Math.min(Math.max(0, m.atMs), window) }))
    .sort((a, b) => a.atMs - b.atMs);

  if (sorted.length === 0) {
    return { byProblem, unattributedMs: window };
  }

  let unattributedMs = 0;
  let prevMs = 0;

  for (const m of sorted) {
    const q = entry(m.problemId);
    q.markers += 1;
    q.firstTouchMs = q.firstTouchMs === null ? m.atMs : Math.min(q.firstTouchMs, m.atMs);
    q.lastTouchMs = q.lastTouchMs === null ? m.atMs : Math.max(q.lastTouchMs, m.atMs);

    const gap = Math.max(0, m.atMs - prevMs);
    const credited = Math.min(gap, idleCapMs);
    q.estimatedMs += credited;
    unattributedMs += gap - credited;
    prevMs = m.atMs;
  }

  const last = sorted[sorted.length - 1];
  const tail = Math.max(0, window - last.atMs);
  const creditedTail = Math.min(tail, idleCapMs);
  entry(last.problemId).estimatedMs += creditedTail;
  unattributedMs += tail - creditedTail;

  return { byProblem, unattributedMs };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface VerdictTally {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Failures grouped by Judge0 status, so "8 wrong answers" reads differently
   *  from "8 timeouts" — one is a wrong algorithm, the other a slow one. */
  byStatus: Record<number, number>;
}

export function tallyVerdicts(runs: { statusId: number | null }[]): VerdictTally {
  const byStatus: Record<number, number> = {};
  for (const r of runs) {
    if (r.statusId) byStatus[r.statusId] = (byStatus[r.statusId] ?? 0) + 1;
  }
  return {
    total: runs.length,
    passed: runs.filter((r) => isAccepted(r.statusId)).length,
    failed: runs.filter((r) => isFailed(r.statusId)).length,
    pending: runs.filter((r) => isPending(r.statusId)).length,
    byStatus,
  };
}

/**
 * Whether two pieces of code differ once formatting is set aside.
 *
 * Used to decide if the draft left in the editor is worth showing next to the
 * last submission, and whether one attempt actually changed anything over the
 * one before it — a candidate who submits the same code three times is telling
 * a different story from one who rewrote it twice.
 */
export function codeChanged(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeCode(a) !== normalizeCode(b);
}

function normalizeCode(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}
