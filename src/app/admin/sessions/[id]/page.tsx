"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { languageShortName } from "@/lib/languages";
import { EVENT_LABELS } from "@/lib/proctor-config";
import { isAccepted, isFailed, statusLabel } from "@/lib/judge0-status";

interface Report {
  id: string;
  assessmentTitle: string;
  assessmentId: string;
  candidateName: string;
  invitedEmail: string;
  signedInAs: string | null;
  state: string;
  startedAt: string;
  submittedAt: string | null;
  durationMinutes: number;
  elapsedMs: number;
  violationCount: number;
  maxViolations: number;
  totalScore: number;
  maxScore: number;
  questions: {
    problemId: string;
    title: string;
    ordinal: number;
    points: number;
    earned: number;
    submissions: number;
    bestAttempt: {
      id: string;
      languageId: number;
      sourceCode: string;
      score: number;
      maxScore: number;
      createdAt: string;
      runs: { ordinal: number; kind: string; statusId: number | null; timeS: number | null; memoryKb: number | null }[];
    } | null;
    timeline: { id: string; atMs: number; score: number; maxScore: number; state: string; languageId: number }[];
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
  }[];
  events: { id: string; event: string; detail: string | null; counted: boolean; atMs: number }[];
}

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SessionReportPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const id = useParams().id as string;
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sessions/${id}`);
    if (!res.ok) {
      setError("Could not load this report.");
      return;
    }
    setReport(await res.json());
  }, [id]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") load();
  }, [session, load]);

  if (!report) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {error ? <p className="text-red-400">{error}</p> : <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500" />}
      </div>
    );
  }

  const pct = report.maxScore > 0 ? Math.round((report.totalScore / report.maxScore) * 100) : 0;
  const countedEvents = report.events.filter((e) => e.counted);

  // A candidate cannot work past their deadline, so anything above the allotted
  // duration is bookkeeping rather than time spent: elapsedMs is measured to
  // submittedAt, which for an abandoned test is only stamped whenever an admin
  // next opens a page, and for a live one is measured to now. Show the window as
  // full and let the state badge say it expired instead of claiming days of work.
  const limitMs = report.durationMinutes * 60_000;
  const overranLimit = report.elapsedMs > limitMs;
  const shownElapsedMs = Math.min(Math.max(0, report.elapsedMs), limitMs);
  const emailMismatch =
    report.signedInAs &&
    report.signedInAs.toLowerCase() !== report.invitedEmail.toLowerCase();

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-700 px-6 py-4 sticky top-0 bg-gray-900 z-10">
        <button
          onClick={() => router.push(`/admin/assessments/${report.assessmentId}`)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          ← {report.assessmentTitle}
        </button>
        <div className="flex items-end justify-between mt-1 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold">{report.candidateName}</h1>
            <p className="text-xs text-gray-500">{report.invitedEmail}</p>
          </div>
          <div className="flex items-center gap-6">
            <Stat label="Score" value={`${report.totalScore}/${report.maxScore}`} accent={pct >= 60 ? "green" : pct >= 30 ? "yellow" : "red"} />
            <Stat
              label={overranLimit ? "Time used (capped)" : "Time used"}
              value={`${clock(shownElapsedMs)} / ${report.durationMinutes}:00`}
              hint={
                overranLimit
                  ? "The test was never submitted from the candidate's side, so the whole window is shown. This is the time available, not time actively worked."
                  : undefined
              }
            />
            <Stat
              label="Warnings"
              value={report.maxViolations > 0 ? `${report.violationCount}/${report.maxViolations}` : String(report.violationCount)}
              accent={report.violationCount > 0 ? "red" : undefined}
            />
            <div>
              <StateBadge state={report.state} />
            </div>
          </div>
        </div>
      </header>

      <main className="p-6 max-w-5xl space-y-6">
        {report.state === "terminated" && (
          <div className="bg-red-950/50 border border-red-900 rounded-lg px-4 py-3 text-sm text-red-200">
            This test was <strong>ended automatically</strong> after{" "}
            {report.violationCount} proctoring warnings. The work below is what existed at that
            moment.
          </div>
        )}
        {emailMismatch && (
          <div className="bg-yellow-950/50 border border-yellow-900 rounded-lg px-4 py-3 text-sm text-yellow-200">
            Signed in as <strong>{report.signedInAs}</strong>, which differs from the invited
            address.
          </div>
        )}

        {/* Per-question breakdown */}
        <section>
          <h2 className="font-semibold mb-3">Questions</h2>
          <div className="space-y-3">
            {report.questions.map((q, i) => {
              const ratio = q.points > 0 ? q.earned / q.points : 0;

              // Test cases are weighted, so an attempt's score/maxScore are points
              // and never a case count. A real count only exists in the verdicts.
              const runs = q.bestAttempt?.runs ?? [];
              const casesPassed = runs.filter((r) => isAccepted(r.statusId)).length;

              // burstChars is summed from a burst list the writer truncates to the
              // last 100 and the report slices to the last 25, while burstCount
              // keeps growing — so the two disagree and only burstCount and
              // largestInsertion can be trusted to describe the whole session.
              const burstsTruncated =
                !!q.integrity && q.integrity.bursts.length < q.integrity.burstCount;
              // A total is only worth stating when every burst is still in the list
              // and there is more than one of them to add up.
              const burstTotal =
                q.integrity && !burstsTruncated && q.integrity.burstCount > 1
                  ? q.integrity.burstChars
                  : null;
              const flagged =
                !!q.integrity &&
                q.integrity.burstCount > 0 &&
                (q.integrity.burstCount > 1 ||
                  q.integrity.largestInsertion > q.integrity.threshold * 2);

              return (
                <div key={q.problemId} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div className="min-w-0">
                      <h3 className="font-medium">
                        <span className="text-gray-500 mr-2">Q{i + 1}</span>
                        {q.title}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {q.submissions} submission{q.submissions === 1 ? "" : "s"}
                        {q.bestAttempt && ` · ${languageShortName(q.bestAttempt.languageId)}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <div
                        className={`font-mono text-lg ${
                          ratio >= 1 ? "text-green-400" : ratio > 0 ? "text-yellow-400" : "text-gray-500"
                        }`}
                      >
                        {q.earned}/{q.points}
                      </div>
                      {q.bestAttempt && (
                        <div className="text-xs text-gray-500">
                          {runs.length > 0 && `${casesPassed}/${runs.length} cases · `}
                          {q.bestAttempt.score}/{q.bestAttempt.maxScore} pts
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Integrity */}
                  {q.integrity && (
                    <div
                      className={`rounded-lg px-3 py-2 mb-3 text-xs ${
                        flagged
                          ? "bg-red-950/40 border border-red-900 text-red-200"
                          : "bg-gray-900 text-gray-400"
                      }`}
                    >
                      {flagged ? (
                        <>
                          <strong>Likely pasted.</strong> {q.integrity.burstCount} insertion
                          {q.integrity.burstCount === 1 ? "" : "s"} larger than{" "}
                          {q.integrity.threshold} chars, the largest {q.integrity.largestInsertion}{" "}
                          chars
                          {burstTotal !== null && ` totalling ${burstTotal} chars`}
                          . Only {clock(q.integrity.activeMs)} of active typing across{" "}
                          {q.integrity.keystrokes} edits.
                        </>
                      ) : (
                        <>
                          Typed normally — {q.integrity.charsTyped} chars over{" "}
                          {q.integrity.keystrokes} edits, {clock(q.integrity.activeMs)} active,
                          largest single insertion {q.integrity.largestInsertion} chars.
                        </>
                      )}
                      {q.integrity.bursts.length > 0 && (
                        <div className="mt-1.5 text-[11px] opacity-80">
                          {burstsTruncated
                            ? `Most recent ${q.integrity.bursts.length} of ${q.integrity.burstCount} insertions: `
                            : "Bursts at "}
                          {q.integrity.bursts
                            .map((b) => `${clock(b.atMs)} (${b.chars}c)`)
                            .join(", ")}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Submission timeline */}
                  {q.timeline.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {q.timeline.map((t) => (
                        <span
                          key={t.id}
                          title={`${clock(t.atMs)} into the test`}
                          className={`text-[11px] px-2 py-0.5 rounded font-mono ${
                            t.maxScore > 0 && t.score === t.maxScore
                              ? "bg-green-900/60 text-green-300"
                              : t.score > 0
                              ? "bg-yellow-900/60 text-yellow-300"
                              : "bg-gray-700 text-gray-400"
                          }`}
                        >
                          {clock(t.atMs)} · {t.score}/{t.maxScore}
                        </span>
                      ))}
                    </div>
                  )}

                  {q.bestAttempt ? (
                    <>
                      <button
                        onClick={() =>
                          setOpenCode(openCode === q.problemId ? null : q.problemId)
                        }
                        className="text-xs px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600"
                      >
                        {openCode === q.problemId ? "Hide" : "View"} best submission
                      </button>

                      {openCode === q.problemId && (
                        <>
                          <pre className="mt-3 bg-gray-950 border border-gray-700 rounded p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto whitespace-pre">
                            {q.bestAttempt.sourceCode}
                          </pre>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {q.bestAttempt.runs.map((r) => (
                              <span
                                key={r.ordinal}
                                className={`text-[11px] px-2 py-0.5 rounded ${
                                  isAccepted(r.statusId)
                                    ? "bg-green-900/50 text-green-300"
                                    : isFailed(r.statusId)
                                    ? "bg-red-900/50 text-red-300"
                                    : "bg-gray-700 text-gray-400"
                                }`}
                                title={`${r.kind} case`}
                              >
                                #{r.ordinal} {statusLabel(r.statusId)}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-gray-600">No submission.</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Proctor timeline */}
        <section>
          <div className="flex items-baseline gap-3 mb-3">
            <h2 className="font-semibold">Proctoring timeline</h2>
            <span className="text-xs text-gray-500">
              {report.events.length} event{report.events.length === 1 ? "" : "s"} ·{" "}
              {countedEvents.length} counted as warnings
            </span>
          </div>

          {report.events.length === 0 ? (
            <p className="text-sm text-gray-500 bg-gray-800 border border-gray-700 rounded-xl p-4">
              Clean run — no violations recorded.
            </p>
          ) : (
            <div className="bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700/60 max-h-[28rem] overflow-y-auto">
              {report.events.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono text-xs text-gray-500 w-14 shrink-0">
                    {clock(e.atMs)}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                      e.counted
                        ? "bg-red-900 text-red-300"
                        : "bg-gray-700 text-gray-300"
                    }`}
                  >
                    {EVENT_LABELS[e.event] ?? e.event}
                  </span>
                  {e.counted && (
                    <span className="text-[11px] text-red-400 shrink-0">warning</span>
                  )}
                  {e.detail && <span className="text-xs text-gray-500 truncate">{e.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent?: "green" | "yellow" | "red";
  /** Spelled out on hover when the number needs a caveat to be read correctly. */
  hint?: string;
}) {
  const color =
    accent === "green"
      ? "text-green-400"
      : accent === "yellow"
      ? "text-yellow-400"
      : accent === "red"
      ? "text-red-400"
      : "text-gray-200";
  return (
    <div className="text-right" title={hint}>
      <div className={`font-mono text-lg ${color}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, [string, string]> = {
    in_progress: ["bg-blue-900 text-blue-300", "in progress"],
    submitted: ["bg-green-900 text-green-300", "submitted"],
    auto_submitted: ["bg-yellow-900 text-yellow-300", "time expired"],
    terminated: ["bg-red-900 text-red-300", "terminated"],
  };
  const [cls, label] = map[state] ?? ["bg-gray-700 text-gray-300", state];
  return <span className={`text-xs px-2.5 py-1 rounded ${cls}`}>{label}</span>;
}
