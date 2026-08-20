"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { languageName, languageShortName } from "@/lib/languages";
import { EVENT_LABELS, COUNTED_EVENTS } from "@/lib/proctor-config";
import { isAccepted, isFailed, statusLabel, JUDGE0_ACCEPTED } from "@/lib/judge0-status";
import { fetchJson, HttpError, errorMessage } from "@/lib/fetch-json";
import {
  Bar,
  SessionStateBadge,
  StatTile,
  clock,
  dateTime,
  percent,
  scoreColor,
  shortDuration,
  timeAgo,
} from "@/components/AdminUI";

// ---------------------------------------------------------------------------
// Shapes, mirroring /api/admin/sessions/[id]
// ---------------------------------------------------------------------------

interface CaseSummary {
  ordinal: number;
  kind: string;
  statusId: number | null;
  timeS: number | null;
  memoryKb: number | null;
  hasOutput: boolean;
}

interface VerdictTally {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  byStatus: Record<number, number>;
}

interface HistoryEntry {
  id: string;
  kind: string;
  state: string;
  score: number;
  maxScore: number;
  languageId: number;
  sourceCode: string;
  createdAt: string;
  finishedAt: string | null;
  atMs: number;
  gradedInMs: number | null;
  changedSincePrevious: boolean;
  slowestCaseS: number | null;
  peakMemoryKb: number | null;
  verdicts: VerdictTally;
  cases: CaseSummary[];
}

interface Question {
  problemId: string;
  title: string;
  slug: string;
  difficulty: string;
  ordinal: number;
  points: number;
  earned: number;
  submissions: number;
  runCount: number;
  totalTestCases: number;
  timeLimitMs: number;
  memoryLimitKb: number;
  languages: number[];
  time: {
    estimatedMs: number;
    firstTouchMs: number | null;
    lastTouchMs: number | null;
    markers: number;
    activeTypingMs: number;
    timeToBestMs: number | null;
    timeToFirstSubmitMs: number | null;
    timeToSolveMs: number | null;
  };
  bestAttempt: {
    id: string;
    languageId: number;
    sourceCode: string;
    score: number;
    maxScore: number;
    atMs: number;
    casesPassed: number;
    casesTotal: number;
    runs: CaseSummary[];
  } | null;
  history: HistoryEntry[];
  draft: {
    code: string;
    languageId: number;
    updatedAt: string;
    atMs: number;
    differsFromLastSubmission: boolean;
  } | null;
  integrity: {
    keystrokes: number;
    charsTyped: number;
    activeMs: number;
    largestInsertion: number;
    burstCount: number;
    burstChars: number;
    bursts: { atMs: number; chars: number }[];
    threshold: number;
  } | null;
}

interface ProctorRow {
  id: string;
  event: string;
  detail: string | null;
  counted: boolean;
  atMs: number;
  createdAt: string;
}

interface Report {
  id: string;
  assessmentTitle: string;
  assessmentId: string;
  candidateName: string;
  candidateEmail: string;
  signedInAs: string | null;
  signedInName: string | null;
  image: string | null;
  state: string;
  startedAt: string;
  endsAt: string;
  submittedAt: string | null;
  lastSeenAt: string;
  durationMinutes: number;
  elapsedMs: number;
  creditedMs: number;
  violationCount: number;
  maxViolations: number;
  totalScore: number;
  maxScore: number;
  totals: {
    questions: number;
    attempted: number;
    solved: number;
    partial: number;
    untouched: number;
    submissions: number;
    runs: number;
    keystrokes: number;
    charsTyped: number;
    activeTypingMs: number;
    unattributedMs: number;
    idleCapMs: number;
    medianGradingMs: number | null;
  };
  events: ProctorRow[];
  questions: Question[];
}

/** Full detail for one attempt, from /api/admin/attempts/[id]. */
interface AttemptDetail {
  id: string;
  runs: {
    id: string;
    ordinal: number;
    kind: string;
    weight: number;
    statusId: number | null;
    exitCode: number | null;
    timeS: number | null;
    memoryKb: number | null;
    stdin: string | null;
    expectedOutput: string | null;
    stdout: string | null;
    stderr: string | null;
    compileOutput: string | null;
    message: string | null;
    stdoutTruncated?: number;
    stderrTruncated?: number;
  }[];
}

// ---------------------------------------------------------------------------
// One hue per question, reused by the allocation bar, the timeline and the
// question cards so a colour means the same thing everywhere on the page. Always
// rendered alongside the Q number — the hue is a shortcut, never the only label.
// ---------------------------------------------------------------------------

const QUESTION_HUES = [
  "#60a5fa", // blue
  "#34d399", // emerald
  "#fbbf24", // amber
  "#c084fc", // purple
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#a3e635", // lime
  "#fb923c", // orange
  "#818cf8", // indigo
  "#2dd4bf", // teal
];

function hueFor(index: number): string {
  return QUESTION_HUES[index % QUESTION_HUES.length];
}

/**
 * How much weight the estimated time on a question can carry.
 *
 * The estimate is built from the timestamps a question happened to produce, so
 * one that produced two says much less than one that produced twenty. Stating
 * that next to the number is the difference between an estimate and a guess.
 */
function confidenceOf(markers: number): { label: string; tone: string } | null {
  if (markers === 0) return { label: "never opened", tone: "text-gray-600" };
  if (markers === 1) return { label: "one marker only", tone: "text-yellow-600" };
  if (markers < 5) return { label: "few markers", tone: "text-gray-600" };
  return null;
}

export default function SessionReportPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const id = useParams().id as string;

  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  const load = useCallback(async () => {
    try {
      setReport(await fetchJson<Report>(`/api/admin/sessions/${id}`));
      setError(null);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.push(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load this report."));
    }
  }, [id, router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") load();
  }, [session, load]);

  if (!report) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <div
            className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500"
            role="status"
            aria-label="Loading report"
          />
        )}
      </div>
    );
  }

  const pct = percent(report.totalScore, report.maxScore);
  const countedEvents = report.events.filter((e) => e.counted);
  const outages = report.events.filter((e) => e.event === "connection_lost").length;

  // A candidate cannot work past their deadline, so anything above the allotted
  // duration is bookkeeping rather than time spent: elapsedMs is measured to
  // submittedAt, which for an abandoned test is only stamped whenever an admin
  // next opens a page, and for a live one is measured to now. Show the window as
  // full and let the state badge say it expired instead of claiming days of work.
  // Credited outage time is part of the window this candidate legitimately had, so
  // it raises the ceiling rather than reading as time they should not have got.
  const creditedMs = report.creditedMs ?? 0;
  const limitMs = report.durationMinutes * 60_000 + creditedMs;
  const overranLimit = report.elapsedMs > limitMs;
  const shownElapsedMs = Math.min(Math.max(0, report.elapsedMs), limitMs);

  // The address is captured from the Google account at start, so a difference
  // means the account was renamed afterwards — worth surfacing, since the name
  // on this report and the one the candidate uses today are then not the same.
  const emailChanged =
    report.signedInAs && report.signedInAs.toLowerCase() !== report.candidateEmail.toLowerCase();

  const live = report.state === "in_progress";

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-700 px-6 py-4 sticky top-0 bg-gray-900/95 backdrop-blur z-20">
        <button
          onClick={() => router.push(`/admin/assessments/${report.assessmentId}`)}
          className="text-xs text-gray-500 hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded"
        >
          ← {report.assessmentTitle}
        </button>

        <div className="flex items-end justify-between mt-1.5 gap-6 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            {report.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={report.image}
                alt=""
                width={40}
                height={40}
                className="w-10 h-10 rounded-full border border-gray-700 shrink-0"
              />
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-bold truncate">{report.candidateName}</h1>
              <p className="text-xs text-gray-500 truncate">{report.candidateEmail}</p>
            </div>
          </div>

          <div className="flex items-center gap-6 flex-wrap">
            <Stat
              label="Score"
              value={`${report.totalScore}/${report.maxScore}`}
              sub={`${pct}%`}
              className={scoreColor(pct)}
            />
            <Stat
              label="Solved"
              value={`${report.totals.solved}/${report.totals.questions}`}
              sub={
                report.totals.partial > 0
                  ? `${report.totals.partial} partial`
                  : `${report.totals.attempted} opened`
              }
            />
            <Stat
              label={overranLimit ? "Time used (capped)" : "Time used"}
              value={`${clock(shownElapsedMs)} / ${clock(limitMs)}`}
              sub={`${percent(shownElapsedMs, limitMs)}% of window`}
              hint={
                overranLimit
                  ? "The test was never submitted from the candidate's side, so the whole window is shown. This is the time available, not time actively worked."
                  : undefined
              }
            />
            {creditedMs > 0 && (
              <Stat
                label="Time restored"
                value={`+${clock(creditedMs)}`}
                className="text-yellow-400"
                hint="Added back for time this candidate spent offline. Their allotted window was extended by this much."
              />
            )}
            <Stat
              label="Warnings"
              value={
                report.maxViolations > 0
                  ? `${report.violationCount}/${report.maxViolations}`
                  : String(report.violationCount)
              }
              sub={`${report.events.length} events logged`}
              className={report.violationCount > 0 ? "text-red-400" : undefined}
            />
            <SessionStateBadge state={report.state} live={live} />
          </div>
        </div>
      </header>

      <main className="p-6 max-w-6xl mx-auto space-y-8">
        {/* Alerts ------------------------------------------------------------ */}
        {report.state === "terminated" && (
          <Alert tone="red">
            This test was <strong>ended automatically</strong> after {report.violationCount}{" "}
            proctoring warnings. The work below is what existed at that moment.
          </Alert>
        )}
        {creditedMs > 0 && (
          <Alert tone="yellow">
            This candidate lost their connection during the test, so{" "}
            <strong>{clock(creditedMs)}</strong> was added back to their clock — their window was{" "}
            {clock(limitMs)} rather than the standard {report.durationMinutes}:00.{" "}
            {outages > 0 && (
              <>
                {outages} disconnection{outages === 1 ? "" : "s"} {outages === 1 ? "is" : "are"} on
                the timeline below with how long each lasted.{" "}
              </>
            )}
            No warning was recorded for any of it.
          </Alert>
        )}
        {emailChanged && (
          <Alert tone="yellow">
            This account now signs in as <strong>{report.signedInAs}</strong>. The test was taken as{" "}
            <strong>{report.candidateEmail}</strong>.
          </Alert>
        )}

        {/* At a glance ------------------------------------------------------- */}
        <section aria-labelledby="glance-heading">
          <h2 id="glance-heading" className="font-semibold mb-3">
            At a glance
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatTile
              label="Submissions"
              value={report.totals.submissions}
              sub={`${report.totals.runs} sample runs`}
            />
            <StatTile
              label="Questions opened"
              value={`${report.totals.attempted}/${report.totals.questions}`}
              sub={report.totals.untouched > 0 ? `${report.totals.untouched} never opened` : "all"}
              accent={report.totals.untouched > 0 ? "yellow" : undefined}
            />
            <StatTile
              label="Active typing"
              value={clock(report.totals.activeTypingMs)}
              sub={`${report.totals.charsTyped.toLocaleString()} chars`}
            />
            <StatTile
              label="Unattributed time"
              value={clock(report.totals.unattributedMs)}
              sub={`gaps over ${clock(report.totals.idleCapMs)}`}
              accent={
                report.totals.unattributedMs > shownElapsedMs * 0.35 ? "yellow" : undefined
              }
            />
            <StatTile
              label="Counted warnings"
              value={report.violationCount}
              sub={`of ${report.events.length} events`}
              accent={report.violationCount > 0 ? "red" : undefined}
            />
            <StatTile
              label="Started"
              value={new Date(report.startedAt).toLocaleTimeString()}
              sub={
                report.submittedAt
                  ? `finished ${new Date(report.submittedAt).toLocaleTimeString()}`
                  : `last seen ${timeAgo(report.lastSeenAt)}`
              }
            />
          </div>
        </section>

        {/* Where the time went ----------------------------------------------- */}
        <TimeAllocation report={report} windowMs={shownElapsedMs} />

        {/* Activity timeline -------------------------------------------------- */}
        <ActivityTimeline report={report} windowMs={Math.max(shownElapsedMs, 1)} />

        {/* Questions ---------------------------------------------------------- */}
        <section aria-labelledby="questions-heading">
          <h2 id="questions-heading" className="font-semibold mb-3">
            Questions
          </h2>
          <div className="space-y-3">
            {report.questions.map((q, i) => (
              <QuestionCard
                key={q.problemId}
                q={q}
                index={i}
                open={openQuestion === q.problemId}
                onToggle={() =>
                  setOpenQuestion(openQuestion === q.problemId ? null : q.problemId)
                }
              />
            ))}
          </div>
        </section>

        {/* Proctoring --------------------------------------------------------- */}
        <ProctorSection events={report.events} counted={countedEvents.length} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where the time went
// ---------------------------------------------------------------------------

function TimeAllocation({ report, windowMs }: { report: Report; windowMs: number }) {
  const segments = useMemo(() => {
    const qs = report.questions
      .map((q, i) => ({
        key: q.problemId,
        label: `Q${i + 1}`,
        title: q.title,
        ms: q.time.estimatedMs,
        hue: hueFor(i),
      }))
      .filter((s) => s.ms > 0)
      .sort((a, b) => b.ms - a.ms);

    if (report.totals.unattributedMs > 0) {
      qs.push({
        key: "__idle",
        label: "Idle",
        title: "No question can be credited with this time",
        ms: report.totals.unattributedMs,
        hue: "#374151",
      });
    }
    return qs;
  }, [report]);

  const total = segments.reduce((s, x) => s + x.ms, 0);
  if (total === 0) return null;

  return (
    <section aria-labelledby="time-heading">
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h2 id="time-heading" className="font-semibold">
          Where the time went
        </h2>
        <span className="text-xs text-gray-500">
          estimated from {report.totals.submissions + report.totals.runs} executions and every
          draft save — see each question for how firm its figure is
        </span>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <div className="flex h-4 w-full rounded overflow-hidden bg-gray-900" role="presentation">
          {segments.map((s) => (
            <div
              key={s.key}
              style={{ width: `${(s.ms / total) * 100}%`, backgroundColor: s.hue }}
              title={`${s.label} — ${s.title}: ${clock(s.ms)}`}
            />
          ))}
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
          {segments.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: s.hue }}
                aria-hidden
              />
              <span className="text-gray-300">{s.label}</span>
              <span className="font-mono tabular-nums text-gray-400">{clock(s.ms)}</span>
              <span className="text-gray-600">{Math.round((s.ms / total) * 100)}%</span>
            </li>
          ))}
        </ul>

        {report.totals.unattributedMs > windowMs * 0.35 && (
          <p className="mt-3 text-xs text-yellow-500/90">
            A large share of the window produced no activity at all, so the split above rests on
            comparatively little evidence.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Activity timeline — one lane per question, plus everything the proctor saw
// ---------------------------------------------------------------------------

function ActivityTimeline({ report, windowMs }: { report: Report; windowMs: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <section aria-labelledby="timeline-heading">
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h2 id="timeline-heading" className="font-semibold">
          Activity timeline
        </h2>
        <span className="text-xs text-gray-500">
          <Legend /> across the {clock(windowMs)} the candidate was in the test
        </span>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 overflow-x-auto">
        <div className="min-w-[36rem] space-y-1.5">
          {report.questions.map((q, i) => (
            <div key={q.problemId} className="flex items-center gap-3">
              <div className="w-36 shrink-0 flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ backgroundColor: hueFor(i) }}
                  aria-hidden
                />
                <span className="text-xs text-gray-400 truncate" title={q.title}>
                  Q{i + 1} {q.title}
                </span>
              </div>

              <div className="relative flex-1 h-6 rounded bg-gray-900/80">
                {q.history.map((h) => {
                  const ratio = h.maxScore > 0 ? h.score / h.maxScore : 0;
                  const tone =
                    h.state !== "done"
                      ? "bg-gray-600"
                      : ratio >= 1
                      ? "bg-green-400"
                      : ratio > 0
                      ? "bg-yellow-400"
                      : "bg-gray-500";
                  return (
                    <span
                      key={h.id}
                      title={`${clock(h.atMs)} · ${h.kind === "submit" ? "Submit" : "Run"} · ${
                        h.score
                      }/${h.maxScore}`}
                      className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 ${tone} ${
                        h.kind === "submit"
                          ? "w-2.5 h-2.5 rounded-[2px]"
                          : "w-1.5 h-1.5 rounded-full opacity-80"
                      }`}
                      style={{ left: `${Math.min(100, (h.atMs / windowMs) * 100)}%` }}
                    />
                  );
                })}
                {q.draft && (
                  <span
                    title={`${clock(q.draft.atMs)} · last edit saved`}
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-px h-3 bg-gray-400/70"
                    style={{ left: `${Math.min(100, (q.draft.atMs / windowMs) * 100)}%` }}
                  />
                )}
              </div>
            </div>
          ))}

          {/* Proctor lane */}
          <div className="flex items-center gap-3 pt-1">
            <div className="w-36 shrink-0 text-xs text-gray-500">Proctoring</div>
            <div className="relative flex-1 h-6 rounded bg-gray-900/80">
              {report.events.map((e) => (
                <span
                  key={e.id}
                  title={`${clock(e.atMs)} · ${EVENT_LABELS[e.event] ?? e.event}${
                    e.counted ? " (warning)" : ""
                  }`}
                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-3.5 rounded-sm ${
                    e.counted ? "bg-red-400" : "bg-gray-500"
                  }`}
                  style={{ left: `${Math.min(100, (e.atMs / windowMs) * 100)}%` }}
                />
              ))}
            </div>
          </div>

          {/* Axis */}
          <div className="flex items-center gap-3 pt-1">
            <div className="w-36 shrink-0" />
            <div className="relative flex-1 h-4">
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute -translate-x-1/2 text-[10px] font-mono tabular-nums text-gray-600"
                  style={{ left: `${t * 100}%` }}
                >
                  {clock(windowMs * t)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Legend() {
  return (
    <span className="inline-flex items-center gap-3 align-middle">
      <span className="inline-flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" aria-hidden /> run
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-2 h-2 rounded-[2px] bg-gray-300" aria-hidden /> submit
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-1 h-3 rounded-sm bg-red-400" aria-hidden /> warning
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

function QuestionCard({
  q,
  index,
  open,
  onToggle,
}: {
  q: Question;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const ratio = q.points > 0 ? q.earned / q.points : 0;
  const hue = hueFor(index);
  const confidence = confidenceOf(q.time.markers);

  // burstChars is summed from a burst list the writer truncates to the last 100
  // and the report slices to the last 25, while burstCount keeps growing — so the
  // two disagree and only burstCount and largestInsertion can be trusted to
  // describe the whole session.
  const burstsTruncated = !!q.integrity && q.integrity.bursts.length < q.integrity.burstCount;
  const burstTotal =
    q.integrity && !burstsTruncated && q.integrity.burstCount > 1 ? q.integrity.burstChars : null;
  const flagged =
    !!q.integrity &&
    q.integrity.burstCount > 0 &&
    (q.integrity.burstCount > 1 || q.integrity.largestInsertion > q.integrity.threshold * 2);

  // Verdicts across every submission, which is what says *how* a question was
  // failed: eight wrong answers is a wrong algorithm, eight timeouts a slow one.
  const submitVerdicts = useMemo(() => {
    const byStatus: Record<number, number> = {};
    for (const h of q.history) {
      if (h.kind !== "submit") continue;
      for (const [k, v] of Object.entries(h.verdicts.byStatus)) {
        byStatus[Number(k)] = (byStatus[Number(k)] ?? 0) + v;
      }
    }
    return Object.entries(byStatus)
      .map(([k, v]) => ({ statusId: Number(k), count: v }))
      .sort((a, b) => b.count - a.count);
  }, [q.history]);

  return (
    <article className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
      <div className="border-l-4 p-4" style={{ borderLeftColor: hue }}>
        {/* Heading -------------------------------------------------------- */}
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0">
            <h3 className="font-medium">
              <span className="text-gray-500 mr-2 font-mono">Q{index + 1}</span>
              {q.title}
            </h3>
            <p className="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="capitalize">{q.difficulty}</span>
              <span aria-hidden>·</span>
              <span>
                {q.submissions} submission{q.submissions === 1 ? "" : "s"}
              </span>
              <span aria-hidden>·</span>
              <span>
                {q.runCount} run{q.runCount === 1 ? "" : "s"}
              </span>
              {q.languages.length > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span title={q.languages.map(languageName).join(", ")}>
                    {q.languages.map(languageShortName).join(" → ")}
                  </span>
                </>
              )}
              <span aria-hidden>·</span>
              <span>{q.totalTestCases} test cases</span>
            </p>
          </div>

          <div className="text-right shrink-0">
            <div
              className={`font-mono tabular-nums text-lg ${
                ratio >= 1 ? "text-green-400" : ratio > 0 ? "text-yellow-400" : "text-gray-500"
              }`}
            >
              {q.earned}/{q.points}
            </div>
            {q.bestAttempt && (
              <div className="text-xs text-gray-500 tabular-nums">
                {q.bestAttempt.casesTotal > 0 &&
                  `${q.bestAttempt.casesPassed}/${q.bestAttempt.casesTotal} cases`}
              </div>
            )}
          </div>
        </div>

        <Bar value={q.earned} max={q.points} tone={ratio >= 1 ? "green" : "blue"} />

        {/* Time ------------------------------------------------------------ */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-3 bg-gray-900/60 rounded-lg p-3">
          <div className="col-span-2 sm:col-span-1">
            <div
              className="font-mono tabular-nums text-xl text-white leading-none"
              title={`Reconstructed from ${q.time.markers} timestamped activity marker${
                q.time.markers === 1 ? "" : "s"
              }. Any single gap longer than the idle cap is not counted here.`}
            >
              {clock(q.time.estimatedMs)}
            </div>
            <div className="text-xs text-gray-400 mt-1.5">Estimated time</div>
            {confidence && (
              <div className={`text-[11px] mt-0.5 ${confidence.tone}`}>{confidence.label}</div>
            )}
          </div>

          <Field label="First touch" value={q.time.firstTouchMs} />
          <Field label="Last touch" value={q.time.lastTouchMs} />
          <Field
            label="Active typing"
            value={q.time.activeTypingMs}
            hint="Exact: the sum of gaps under 5s between keystrokes. Effort, not time on the question."
          />
          <Field
            label="To first submit"
            value={q.time.timeToFirstSubmitMs}
            hint="Measured from the start of the test."
          />
          <Field
            label="To full marks"
            value={q.time.timeToSolveMs}
            hint="The first submission that passed every test case, measured from the start of the test."
          />
        </div>

        {/* Verdict spread ---------------------------------------------------- */}
        {submitVerdicts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {submitVerdicts.map((v) => (
              <span
                key={v.statusId}
                className={`text-[11px] px-2 py-0.5 rounded ${
                  v.statusId === JUDGE0_ACCEPTED
                    ? "bg-green-900/50 text-green-300"
                    : "bg-red-900/40 text-red-300"
                }`}
              >
                {statusLabel(v.statusId)} <span className="font-mono">×{v.count}</span>
              </span>
            ))}
            <span className="text-[11px] text-gray-600 px-1 py-0.5">across all submissions</span>
          </div>
        )}

        {/* Integrity --------------------------------------------------------- */}
        {q.integrity && (
          <div
            className={`rounded-lg px-3 py-2 mt-3 text-xs ${
              flagged
                ? "bg-red-950/40 border border-red-900 text-red-200"
                : "bg-gray-900 text-gray-400"
            }`}
          >
            {flagged ? (
              <>
                <strong>Likely pasted.</strong> {q.integrity.burstCount} insertion
                {q.integrity.burstCount === 1 ? "" : "s"} larger than {q.integrity.threshold} chars,
                the largest {q.integrity.largestInsertion} chars
                {burstTotal !== null && ` totalling ${burstTotal} chars`}. Only{" "}
                {clock(q.integrity.activeMs)} of active typing across {q.integrity.keystrokes} edits.
              </>
            ) : (
              <>
                Typed normally — {q.integrity.charsTyped} chars over {q.integrity.keystrokes} edits,{" "}
                {clock(q.integrity.activeMs)} active, largest single insertion{" "}
                {q.integrity.largestInsertion} chars.
              </>
            )}
            {q.integrity.bursts.length > 0 && (
              <div className="mt-1.5 text-[11px] opacity-80">
                {burstsTruncated
                  ? `Most recent ${q.integrity.bursts.length} of ${q.integrity.burstCount} insertions: `
                  : "Bursts at "}
                {q.integrity.bursts.map((b) => `${clock(b.atMs)} (${b.chars}c)`).join(", ")}
              </div>
            )}
          </div>
        )}

        {/* Unsubmitted work -------------------------------------------------- */}
        {q.draft && q.draft.differsFromLastSubmission && (
          <div className="mt-3 rounded-lg px-3 py-2 text-xs bg-yellow-950/30 border border-yellow-900/60 text-yellow-100">
            {q.submissions === 0 ? (
              <>
                <strong>Written but never submitted.</strong> {q.draft.code.length} characters were
                left in the editor at {clock(q.draft.atMs)}, and nothing was ever run against the
                test cases. This scores zero, but it is not an untouched question.
              </>
            ) : (
              <>
                The editor was still being changed after the last submission — {q.draft.code.length}{" "}
                characters at {clock(q.draft.atMs)}, which were never submitted.
              </>
            )}
          </div>
        )}

        {q.submissions === 0 && q.runCount === 0 && !q.draft && (
          <p className="mt-3 text-xs text-gray-600">
            Never opened — no runs, no submissions, nothing typed.
          </p>
        )}

        {/* History ----------------------------------------------------------- */}
        {q.history.length > 0 && (
          <>
            <button
              onClick={onToggle}
              aria-expanded={open}
              className="mt-4 text-xs px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 transition-colors"
            >
              {open ? "Hide" : "Show"} full history ({q.history.length} execution
              {q.history.length === 1 ? "" : "s"})
            </button>

            {open && (
              <ol className="mt-3 space-y-2">
                {q.history.map((h, i) => (
                  <AttemptRow
                    key={h.id}
                    entry={h}
                    index={i}
                    isBest={q.bestAttempt?.id === h.id}
                    timeLimitMs={q.timeLimitMs}
                  />
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="font-mono tabular-nums text-sm text-gray-200 leading-none pt-1">
        {value === null ? <span className="text-gray-600">—</span> : clock(value)}
      </div>
      <div className="text-xs text-gray-500 mt-1.5">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One run or submission, with its code and — on demand — what each case did
// ---------------------------------------------------------------------------

function AttemptRow({
  entry,
  index,
  isBest,
  timeLimitMs,
}: {
  entry: HistoryEntry;
  index: number;
  isBest: boolean;
  timeLimitMs: number;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [openCase, setOpenCase] = useState<number | null>(null);

  const ratio = entry.maxScore > 0 ? entry.score / entry.maxScore : 0;
  const isSubmit = entry.kind === "submit";

  // Fetched only when a row is opened: the per-case input and output is the one
  // genuinely heavy payload here, and a session holds dozens of these rows.
  const expand = async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail || loading) return;

    setLoading(true);
    setFailedToLoad(false);
    try {
      setDetail(await fetchJson<AttemptDetail>(`/api/admin/attempts/${entry.id}`));
    } catch {
      setFailedToLoad(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <li className="bg-gray-900 border border-gray-700/70 rounded-lg">
      <button
        onClick={expand}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-800/60 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 transition-colors"
      >
        <span className="font-mono tabular-nums text-xs text-gray-500 w-16 shrink-0">
          {clock(entry.atMs)}
        </span>

        <span
          className={`text-[11px] px-2 py-0.5 rounded shrink-0 w-16 text-center ${
            isSubmit ? "bg-blue-900/60 text-blue-200" : "bg-gray-700 text-gray-300"
          }`}
        >
          {isSubmit ? "Submit" : "Run"}
        </span>

        <span
          className={`font-mono tabular-nums text-xs shrink-0 w-14 ${
            entry.state !== "done"
              ? "text-gray-500"
              : ratio >= 1
              ? "text-green-400"
              : ratio > 0
              ? "text-yellow-400"
              : "text-gray-500"
          }`}
        >
          {entry.state === "done" ? `${entry.score}/${entry.maxScore}` : entry.state}
        </span>

        <span className="text-[11px] text-gray-600 shrink-0">
          {languageShortName(entry.languageId)}
        </span>

        <span className="flex gap-0.5 min-w-0 flex-wrap">
          {entry.cases.map((c) => (
            <span
              key={c.ordinal}
              title={`#${c.ordinal} ${c.kind} · ${statusLabel(c.statusId)}`}
              className={`w-2 h-4 rounded-[2px] ${
                isAccepted(c.statusId)
                  ? "bg-green-500/70"
                  : isFailed(c.statusId)
                  ? "bg-red-500/70"
                  : "bg-gray-600"
              }`}
            />
          ))}
        </span>

        <span className="ml-auto flex items-center gap-3 shrink-0 text-[11px] text-gray-600 tabular-nums">
          {isBest && <span className="text-green-500">best</span>}
          {!entry.changedSincePrevious && (
            <span className="text-yellow-600" title="Byte-identical to the previous execution">
              unchanged
            </span>
          )}
          {entry.slowestCaseS !== null && (
            <span
              className={
                entry.slowestCaseS * 1000 > timeLimitMs * 0.8 ? "text-yellow-500" : undefined
              }
              title={`Slowest case, against a ${timeLimitMs} ms limit`}
            >
              {entry.slowestCaseS.toFixed(2)}s
            </span>
          )}
          {entry.peakMemoryKb !== null && <span>{Math.round(entry.peakMemoryKb / 1024)} MB</span>}
          <span aria-hidden className="text-gray-700">
            {open ? "▲" : "▼"}
          </span>
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <h4 className="text-[11px] uppercase tracking-wide text-gray-500">
                Code as submitted
              </h4>
              <span className="text-[11px] text-gray-600">
                {dateTime(entry.createdAt)}
                {entry.gradedInMs !== null && ` · graded in ${shortDuration(entry.gradedInMs)}`}
              </span>
            </div>
            <pre className="bg-gray-950 border border-gray-700 rounded p-3 text-xs overflow-x-auto max-h-80 overflow-y-auto whitespace-pre">
              {entry.sourceCode}
            </pre>
          </div>

          <div>
            <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              Test cases
              {loading && <span className="ml-2 text-gray-600 normal-case">loading detail…</span>}
              {failedToLoad && (
                <span className="ml-2 text-red-400 normal-case">
                  could not load inputs and outputs
                </span>
              )}
            </h4>

            <div className="border border-gray-700 rounded divide-y divide-gray-700/60 overflow-hidden">
              {entry.cases.map((c) => {
                const full = detail?.runs.find((r) => r.ordinal === c.ordinal);
                const isOpen = openCase === c.ordinal;
                return (
                  <div key={c.ordinal}>
                    <button
                      onClick={() => setOpenCase(isOpen ? null : c.ordinal)}
                      aria-expanded={isOpen}
                      disabled={!full}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-3 text-xs hover:bg-gray-800/60 disabled:hover:bg-transparent disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 transition-colors"
                    >
                      <span className="font-mono text-gray-500 w-8 shrink-0">#{c.ordinal}</span>
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${
                          c.kind === "sample"
                            ? "bg-gray-700 text-gray-300"
                            : "bg-gray-800 text-gray-500 border border-gray-700"
                        }`}
                      >
                        {c.kind}
                      </span>
                      <span
                        className={
                          isAccepted(c.statusId)
                            ? "text-green-400"
                            : isFailed(c.statusId)
                            ? "text-red-400"
                            : "text-gray-500"
                        }
                      >
                        {statusLabel(c.statusId)}
                      </span>
                      <span className="ml-auto flex gap-3 text-gray-600 tabular-nums shrink-0">
                        {c.timeS !== null && <span>{c.timeS.toFixed(3)}s</span>}
                        {c.memoryKb !== null && <span>{Math.round(c.memoryKb / 1024)} MB</span>}
                        {full && <span aria-hidden>{isOpen ? "▲" : "▼"}</span>}
                      </span>
                    </button>

                    {isOpen && full && <CaseDetail run={full} />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function CaseDetail({ run }: { run: AttemptDetail["runs"][number] }) {
  const mismatch = !isAccepted(run.statusId);
  return (
    <div className="px-3 pb-3 pt-1 space-y-2 bg-gray-950/60">
      <div className="grid gap-2 md:grid-cols-3">
        <IO label="Input" value={run.stdin} />
        <IO label="Expected output" value={run.expectedOutput} />
        <IO
          label="Actual output"
          value={run.stdout}
          truncatedAt={run.stdoutTruncated}
          tone={mismatch ? "bad" : "good"}
        />
      </div>
      {run.stderr && <IO label="stderr" value={run.stderr} truncatedAt={run.stderrTruncated} tone="bad" />}
      {run.compileOutput && <IO label="Compiler output" value={run.compileOutput} tone="bad" />}
      {run.message && <IO label="Judge message" value={run.message} tone="bad" />}
      {run.exitCode !== null && run.exitCode !== 0 && (
        <p className="text-[11px] text-gray-500">
          Exit code <span className="font-mono text-gray-400">{run.exitCode}</span>
        </p>
      )}
    </div>
  );
}

function IO({
  label,
  value,
  tone,
  truncatedAt,
}: {
  label: string;
  value: string | null;
  tone?: "good" | "bad";
  truncatedAt?: number;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <pre
        className={`text-xs rounded border p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre ${
          tone === "bad"
            ? "border-red-900/60 bg-red-950/20 text-red-100"
            : tone === "good"
            ? "border-green-900/60 bg-green-950/20 text-green-100"
            : "border-gray-700 bg-gray-950 text-gray-300"
        }`}
      >
        {value === null || value === "" ? <span className="text-gray-600">(empty)</span> : value}
      </pre>
      {truncatedAt && (
        <p className="text-[11px] text-gray-600 mt-1">
          Truncated — {truncatedAt.toLocaleString()} characters in total.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proctoring
// ---------------------------------------------------------------------------

function ProctorSection({ events, counted }: { events: ProctorRow[]; counted: number }) {
  const [showAll, setShowAll] = useState(false);

  const grouped = useMemo(() => {
    const byEvent = new Map<string, { count: number; counted: number }>();
    for (const e of events) {
      const g = byEvent.get(e.event) ?? { count: 0, counted: 0 };
      g.count += 1;
      if (e.counted) g.counted += 1;
      byEvent.set(e.event, g);
    }
    return Array.from(byEvent.entries())
      .map(([event, g]) => ({ event, ...g }))
      .sort((a, b) => b.counted - a.counted || b.count - a.count);
  }, [events]);

  const visible = showAll ? events : events.slice(0, 40);

  return (
    <section aria-labelledby="proctor-heading">
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h2 id="proctor-heading" className="font-semibold">
          Proctoring
        </h2>
        <span className="text-xs text-gray-500">
          {events.length} event{events.length === 1 ? "" : "s"} · {counted} counted as warnings
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-gray-500 bg-gray-800 border border-gray-700 rounded-xl p-4">
          Clean run — no violations recorded.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex flex-wrap gap-2">
            {grouped.map((g) => {
              const isCounted = (COUNTED_EVENTS as readonly string[]).includes(g.event);
              return (
                <span
                  key={g.event}
                  className={`text-xs px-2.5 py-1 rounded flex items-center gap-2 ${
                    g.counted > 0
                      ? "bg-red-950/60 border border-red-900 text-red-200"
                      : "bg-gray-900 border border-gray-700 text-gray-400"
                  }`}
                  title={
                    isCounted
                      ? "This event type burns a warning."
                      : "Recorded but never counted as a warning."
                  }
                >
                  {EVENT_LABELS[g.event] ?? g.event}
                  <span className="font-mono tabular-nums">×{g.count}</span>
                  {g.counted > 0 && (
                    <span className="text-[10px] uppercase tracking-wide">
                      {g.counted} warning{g.counted === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              );
            })}
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700/60 overflow-hidden">
            {visible.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="font-mono tabular-nums text-xs text-gray-500 w-16 shrink-0">
                  {clock(e.atMs)}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                    e.counted ? "bg-red-900 text-red-300" : "bg-gray-700 text-gray-300"
                  }`}
                >
                  {EVENT_LABELS[e.event] ?? e.event}
                </span>
                {e.counted && <span className="text-[11px] text-red-400 shrink-0">warning</span>}
                {e.detail && <span className="text-xs text-gray-500 truncate">{e.detail}</span>}
                <span className="ml-auto text-[11px] text-gray-700 shrink-0 tabular-nums">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </div>
            ))}

            {events.length > visible.length && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full px-4 py-2 text-xs text-gray-400 hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 transition-colors"
              >
                Show the remaining {events.length - visible.length} events
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  sub,
  className,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  className?: string;
  /** Spelled out on hover when the number needs a caveat to be read correctly. */
  hint?: string;
}) {
  return (
    <div className="text-right" title={hint}>
      <div className={`font-mono tabular-nums text-lg ${className ?? "text-gray-200"}`}>
        {value}
      </div>
      <div className="text-xs text-gray-500">{label}</div>
      {sub && <div className="text-[11px] text-gray-600">{sub}</div>}
    </div>
  );
}

function Alert({ tone, children }: { tone: "red" | "yellow"; children: React.ReactNode }) {
  const cls =
    tone === "red"
      ? "bg-red-950/50 border-red-900 text-red-200"
      : "bg-yellow-950/40 border-yellow-900 text-yellow-100";
  return <div className={`border rounded-lg px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
