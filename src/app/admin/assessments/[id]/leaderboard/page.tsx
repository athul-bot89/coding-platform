"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchJson, errorMessage, HttpError } from "@/lib/fetch-json";

interface Question {
  problemId: string;
  ordinal: number;
  title: string;
  points: number;
}

interface Row {
  rank: number;
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  image: string | null;
  state: string;
  totalScore: number;
  maxScore: number;
  perProblem: Record<string, number>;
  solvedCount: number;
  submissionCount: number;
  violationCount: number;
  startedAt: string;
  submittedAt: string | null;
  elapsedMs: number;
  creditedMs: number;
  live: boolean;
}

interface Board {
  assessment: {
    id: string;
    title: string;
    durationMinutes: number;
    maxViolations: number;
    isActive: boolean;
    totalPoints: number;
  };
  questions: Question[];
  rows: Row[];
}

/** Refresh cadence while anyone is still sitting the test. */
const LIVE_REFRESH_MS = 20_000;

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export default function LeaderboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const id = useParams().id as string;

  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showFinishedOnly, setShowFinishedOnly] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const body = await fetchJson<Board>(`/api/admin/assessments/${id}/leaderboard`);
      setBoard({
        ...body,
        questions: Array.isArray(body.questions) ? body.questions : [],
        rows: Array.isArray(body.rows) ? body.rows : [],
      });
      setError(null);
    } catch (err) {
      // The admin role cached in the session cookie can outlive the server's view
      // of it, so a 401 or 403 means this browser is no longer an admin.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.push(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load the leaderboard."));
    } finally {
      setRefreshing(false);
    }
  }, [id, router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") load();
  }, [session, load]);

  // Scores of anyone still working keep moving, so the table follows them. Once
  // every candidate has finished the numbers are frozen and polling stops.
  const anyLive = !!board?.rows.some((r) => r.live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(load, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [anyLive, load]);

  const visible = useMemo(
    () => (board ? board.rows.filter((r) => !showFinishedOnly || !r.live) : []),
    [board, showFinishedOnly]
  );

  const stats = useMemo(() => {
    if (!board) return null;
    const done = board.rows.filter((r) => !r.live);
    const scores = done.map((r) => r.totalScore);
    const sorted = [...scores].sort((a, b) => a - b);
    return {
      started: board.rows.length,
      live: board.rows.length - done.length,
      completed: done.length,
      average: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0,
      median: sorted.length
        ? sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : 0,
      top: scores.length ? Math.max(...scores) : 0,
    };
  }, [board]);

  const exportCsv = () => {
    if (!board) return;
    const header = [
      "Rank",
      "Name",
      "Email",
      "Score",
      "Max",
      "Percent",
      ...board.questions.map((q, i) => `Q${i + 1} ${q.title} (${q.points})`),
      "Solved",
      "Submissions",
      "Warnings",
      "Time taken",
      "Time restored (offline)",
      "Status",
      "Started at",
      "Submitted at",
    ];

    // Anything that starts with a formula character is prefixed, so a name like
    // "=cmd" cannot execute when the file is opened in a spreadsheet.
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };

    const lines = [
      header.map(cell).join(","),
      ...board.rows.map((r) =>
        [
          r.rank,
          r.candidateName,
          r.candidateEmail,
          r.totalScore,
          r.maxScore,
          r.maxScore > 0 ? Math.round((r.totalScore / r.maxScore) * 100) : 0,
          ...board.questions.map((q) => r.perProblem[q.problemId] ?? 0),
          r.solvedCount,
          r.submissionCount,
          r.violationCount,
          clock(r.elapsedMs),
          r.creditedMs > 0 ? clock(r.creditedMs) : "",
          r.live ? "in progress" : r.state,
          new Date(r.startedAt).toISOString(),
          r.submittedAt ? new Date(r.submittedAt).toISOString() : "",
        ]
          .map(cell)
          .join(",")
      ),
    ];

    const url = URL.createObjectURL(
      new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${board.assessment.title.replace(/[^\w-]+/g, "_")}-leaderboard.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!board) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {error ? (
          <div className="text-center">
            <p className="text-red-400 mb-3">{error}</p>
            <button onClick={load} className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600">
              Try again
            </button>
          </div>
        ) : (
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500" />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-700 px-6 py-4 sticky top-0 bg-gray-900 z-10">
        <button
          onClick={() => router.push(`/admin/assessments/${id}`)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          ← {board.assessment.title}
        </button>
        <div className="flex items-center justify-between gap-4 mt-1 flex-wrap">
          <h1 className="text-xl font-bold">Leaderboard</h1>
          <div className="flex items-center gap-2">
            {anyLive && (
              <span className="flex items-center gap-1.5 text-xs text-blue-300">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                live
              </span>
            )}
            <label className="flex items-center gap-1.5 text-xs text-gray-400 mr-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showFinishedOnly}
                onChange={(e) => setShowFinishedOnly(e.target.checked)}
                className="w-3.5 h-3.5 accent-green-600"
              />
              Finished only
            </label>
            <button
              onClick={load}
              disabled={refreshing}
              className="px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              onClick={exportCsv}
              disabled={board.rows.length === 0}
              className="px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>
        </div>
      </header>

      <main className="p-6 space-y-5">
        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              ["Started", String(stats.started)],
              ["In progress", String(stats.live)],
              ["Completed", String(stats.completed)],
              ["Top score", `${stats.top}/${board.assessment.totalPoints}`],
              ["Average", `${stats.average}/${board.assessment.totalPoints}`],
              ["Median", `${stats.median}/${board.assessment.totalPoints}`],
            ].map(([label, value]) => (
              <div key={label} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="text-lg font-semibold">{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        )}

        {board.rows.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="mb-2">Nobody has taken this test yet.</p>
            <p className="text-sm">Share the test link and results will appear here as they finish.</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-center py-16 text-gray-500 text-sm">
            Everyone is still working. Untick “Finished only” to see live standings.
          </p>
        ) : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="py-3 pl-4 pr-2 w-14">#</th>
                  <th className="py-3 pr-3">Candidate</th>
                  <th className="py-3 pr-3 text-right">Score</th>
                  {board.questions.map((q, i) => (
                    <th key={q.problemId} className="py-3 px-2 text-center" title={q.title}>
                      <div className="text-xs">Q{i + 1}</div>
                      <div className="text-[10px] text-gray-600 font-normal">{q.points}</div>
                    </th>
                  ))}
                  <th className="py-3 px-3 text-right">Time</th>
                  <th className="py-3 px-2 text-center" title="Warnings recorded">
                    ⚠
                  </th>
                  <th className="py-3 pr-3">Status</th>
                  <th className="py-3 pr-4" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const pct = r.maxScore > 0 ? Math.round((r.totalScore / r.maxScore) * 100) : 0;
                  return (
                    <tr
                      key={r.sessionId}
                      className="border-b border-gray-800 last:border-0 hover:bg-gray-900/50"
                    >
                      <td className="py-3 pl-4 pr-2">
                        <RankBadge rank={r.rank} live={r.live} />
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium truncate max-w-[16rem]">{r.candidateName}</div>
                        <div className="text-xs text-gray-500 truncate max-w-[16rem]">
                          {r.candidateEmail}
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-right whitespace-nowrap">
                        <span
                          className={`font-mono font-semibold ${
                            pct >= 60 ? "text-green-400" : pct >= 30 ? "text-yellow-400" : "text-red-400"
                          }`}
                        >
                          {r.totalScore}
                        </span>
                        <span className="text-gray-600 font-mono text-xs">/{r.maxScore}</span>
                        <div className="text-[10px] text-gray-600">
                          {r.solvedCount}/{board.questions.length} solved
                        </div>
                      </td>
                      {board.questions.map((q) => {
                        const earned = r.perProblem[q.problemId];
                        // No entry means this question was never on their paper —
                        // it was added to the test after they started.
                        if (earned === undefined) {
                          return (
                            <td
                              key={q.problemId}
                              className="py-3 px-2 text-center text-gray-700 text-xs"
                              title="Not served to this candidate"
                            >
                              –
                            </td>
                          );
                        }
                        const full = earned >= q.points;
                        return (
                          <td key={q.problemId} className="py-3 px-2 text-center">
                            <span
                              className={`inline-block min-w-[2.25rem] rounded px-1.5 py-0.5 text-xs font-mono ${
                                full
                                  ? "bg-green-900/60 text-green-300"
                                  : earned > 0
                                  ? "bg-yellow-900/50 text-yellow-300"
                                  : "bg-gray-900 text-gray-600"
                              }`}
                            >
                              {earned}
                            </span>
                          </td>
                        );
                      })}
                      <td className="py-3 px-3 text-right font-mono text-xs text-gray-400 whitespace-nowrap">
                        {clock(r.elapsedMs)}
                        {r.creditedMs > 0 && (
                          <div
                            className="text-[10px] text-yellow-500"
                            title={`${clock(
                              r.creditedMs
                            )} was added back to this candidate's clock for time spent offline`}
                          >
                            +{clock(r.creditedMs)} offline
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-2 text-center">
                        <span
                          className={`text-xs font-mono ${
                            r.violationCount > 0 ? "text-red-400" : "text-gray-600"
                          }`}
                        >
                          {r.violationCount}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <StateBadge state={r.state} />
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <button
                          onClick={() => router.push(`/admin/sessions/${r.sessionId}`)}
                          className="text-xs px-3 py-1 bg-purple-900/60 rounded hover:bg-purple-900 whitespace-nowrap"
                        >
                          Report
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-600">
          Ranked by score, then by who finished faster. Each question counts a candidate&apos;s best
          submission, so retrying never costs them points. Candidates still working are ranked on
          their running total and marked <em>in progress</em> — their position is not final. Time a
          candidate lost to a connection outage is added back to their clock and discounted from the
          speed comparison, so a dropped connection cannot cost them a place.
        </p>
      </main>
    </div>
  );
}

function RankBadge({ rank, live }: { rank: number; live: boolean }) {
  // Medals are for a settled result. A candidate who is still typing can be
  // sitting first on a partial score, and a gold badge would read as a verdict.
  if (!live && rank <= 3) {
    const medal = ["🥇", "🥈", "🥉"][rank - 1];
    return <span className="text-lg" title={`Rank ${rank}`}>{medal}</span>;
  }
  return <span className="font-mono text-sm text-gray-500">{rank}</span>;
}

function StateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    in_progress: "bg-blue-900 text-blue-300",
    submitted: "bg-green-900 text-green-300",
    auto_submitted: "bg-yellow-900 text-yellow-300",
    terminated: "bg-red-900 text-red-300",
  };
  const labels: Record<string, string> = {
    in_progress: "in progress",
    submitted: "submitted",
    auto_submitted: "time expired",
    terminated: "terminated",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${
        styles[state] ?? "bg-gray-700 text-gray-300"
      }`}
    >
      {labels[state] ?? state}
    </span>
  );
}
