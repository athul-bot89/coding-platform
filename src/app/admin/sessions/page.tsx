"use client";

// Every candidate run, across every test.
//
// The per-test leaderboard answers "who won this test"; this answers "what has
// this person done", "who is flagged", and "what happened today" — questions
// that cut across tests and have nowhere else to live.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Empty,
  Pagination,
  Panel,
  Score,
  SessionStateBadge,
  WarningCount,
  clock,
  dateTime,
  shortDuration,
  timeAgo,
  useTicker,
} from "@/components/AdminUI";
import { errorMessage, fetchJson, HttpError } from "@/lib/fetch-json";
import { ONLINE_GRACE_MS } from "@/lib/proctor-config";

interface Row {
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  image: string | null;
  signedInAs: string | null;
  assessmentId: string;
  assessmentTitle: string;
  maxViolations: number;
  state: string;
  live: boolean;
  totalScore: number;
  maxScore: number;
  solvedCount: number;
  questionCount: number;
  submissionCount: number;
  violationCount: number;
  startedAt: string;
  submittedAt: string | null;
  endsAt: string;
  lastSeenAt: string;
  idleMs: number;
  elapsedMs: number;
}

interface Body {
  serverNow: number;
  sessions: Row[];
  assessments: { id: string; title: string }[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  { value: "live", label: "In progress" },
  { value: "finished", label: "Finished (any)" },
  { value: "submitted", label: "Submitted" },
  { value: "auto_submitted", label: "Time expired" },
  { value: "terminated", label: "Terminated" },
];

const SORT_OPTIONS = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "warnings", label: "Most warnings" },
  { value: "score", label: "Highest final score" },
];

const SEARCH_DEBOUNCE_MS = 350;
const LIVE_REFRESH_MS = 20_000;

export default function AdminSessionsPage() {
  const router = useRouter();

  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [assessmentId, setAssessmentId] = useState("");
  const [state, setState] = useState("");
  const [flagged, setFlagged] = useState(false);
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);

  // "Time left" runs off the server's clock; a browser several minutes out would
  // otherwise show a candidate more or less time than they actually have.
  const skewRef = useRef(0);

  // Filters arrive as query params from the dashboard tiles. Read once on mount
  // rather than through useSearchParams, which would need a Suspense boundary
  // around the whole page to survive a production build.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setState(params.get("state") ?? "");
    setAssessmentId(params.get("assessmentId") ?? "");
    setFlagged(params.get("flagged") === "1");
    const initialQ = params.get("q") ?? "";
    setQ(initialQ);
    setDebouncedQ(initialQ);
    setReady(true);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "25", sort });
      if (debouncedQ) params.set("q", debouncedQ);
      if (assessmentId) params.set("assessmentId", assessmentId);
      if (state) params.set("state", state);
      if (flagged) params.set("flagged", "1");

      const data = await fetchJson<Body>(`/api/admin/sessions?${params}`);
      skewRef.current = Date.now() - data.serverNow;
      setBody({ ...data, sessions: Array.isArray(data.sessions) ? data.sessions : [] });
      setError(null);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load candidate runs."));
    } finally {
      setLoading(false);
    }
  }, [router, page, sort, debouncedQ, assessmentId, state, flagged]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  // Anything on screen that is still running keeps moving; follow it.
  const anyLive = !!body?.sessions.some((s) => s.live);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(load, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [anyLive, load]);
  useTicker(anyLive);

  /** Any filter change restarts at page 1 — page 4 of a new result set is noise. */
  const applyFilter = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const resetRun = async (row: Row) => {
    const ok = confirm(
      `Let ${row.candidateName} retake “${row.assessmentTitle}”?\n\n` +
        "This permanently deletes their run: every submission, their score, the proctoring log, " +
        "saved drafts and typing metrics. It cannot be undone.\n\n" +
        "Afterwards the test link works for them again as a fresh attempt."
    );
    if (!ok) return;

    setBusyId(row.sessionId);
    try {
      await fetchJson(`/api/admin/sessions/${row.sessionId}`, { method: "DELETE" });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not clear that run."));
      return;
    } finally {
      setBusyId(null);
    }
    load();
  };

  const total = body?.pagination.total ?? 0;
  const filtered = !!(debouncedQ || assessmentId || state || flagged);

  return (
    <div>
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 bg-gray-900 z-10">
        <div>
          <h1 className="text-xl font-bold">Candidate runs</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            One row per person per test{anyLive && " · live rows refresh automatically"}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      <main className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => applyFilter(() => setQ(e.target.value))}
            placeholder="Search name or email…"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-64"
          />
          <select
            value={assessmentId}
            onChange={(e) => applyFilter(() => setAssessmentId(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm max-w-[16rem]"
          >
            <option value="">All tests</option>
            {(body?.assessments ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
          <select
            value={state}
            onChange={(e) => applyFilter(() => setState(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm"
          >
            {STATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => applyFilter(() => setSort(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer px-2">
            <input
              type="checkbox"
              checked={flagged}
              onChange={(e) => applyFilter(() => setFlagged(e.target.checked))}
              className="w-3.5 h-3.5 accent-red-600"
            />
            Flagged only
          </label>
          {filtered && (
            <button
              onClick={() =>
                applyFilter(() => {
                  setQ("");
                  setDebouncedQ("");
                  setAssessmentId("");
                  setState("");
                  setFlagged(false);
                })
              }
              className="text-xs text-gray-500 hover:text-gray-300 px-2"
            >
              Clear filters
            </button>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        <Panel
          title="Runs"
          count={
            body
              ? `${total.toLocaleString()} match${total === 1 ? "" : "es"}${
                  filtered ? " for these filters" : ""
                }`
              : undefined
          }
        >
          {!body && loading ? (
            <Empty>Loading…</Empty>
          ) : body && body.sessions.length === 0 ? (
            <Empty>
              {filtered
                ? "No runs match these filters."
                : "Nobody has taken a test yet. Share a test link and runs appear here."}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">Candidate</th>
                    <th className="py-2 pr-3 font-medium">Test</th>
                    <th className="py-2 pr-3 font-medium text-right">Score</th>
                    <th className="py-2 pr-3 font-medium text-right">Time</th>
                    <th className="py-2 pr-3 font-medium text-center">⚠</th>
                    <th className="py-2 pr-3 font-medium">State</th>
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {(body?.sessions ?? []).map((r) => (
                    <tr
                      key={r.sessionId}
                      className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <div className="font-medium truncate max-w-[15rem]">{r.candidateName}</div>
                        <div className="text-xs text-gray-500 truncate max-w-[15rem]">
                          {r.candidateEmail}
                        </div>
                        {r.signedInAs &&
                          r.signedInAs.toLowerCase() !== r.candidateEmail.toLowerCase() && (
                            <div
                              className="text-[11px] text-yellow-500"
                              title={`This account now signs in as ${r.signedInAs}`}
                            >
                              account renamed since
                            </div>
                          )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/admin/assessments/${r.assessmentId}/leaderboard`}
                          className="text-xs text-gray-300 hover:text-white truncate block max-w-[12rem]"
                        >
                          {r.assessmentTitle}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <Score
                          score={r.totalScore}
                          max={r.maxScore}
                          sub={`${r.solvedCount}/${r.questionCount} solved · ${r.submissionCount} submit${
                            r.submissionCount === 1 ? "" : "s"
                          }`}
                        />
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs text-gray-400 whitespace-nowrap">
                        {r.live ? (
                          <span
                            className="text-blue-300"
                            title={`Ends ${dateTime(r.endsAt)}`}
                          >
                            {clock(
                              Math.max(
                                0,
                                new Date(r.endsAt).getTime() - (Date.now() - skewRef.current)
                              )
                            )}{" "}
                            left
                          </span>
                        ) : (
                          clock(r.elapsedMs)
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-center">
                        <WarningCount count={r.violationCount} max={r.maxViolations} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <SessionStateBadge state={r.state} live={r.live} />
                        {r.live && r.idleMs > ONLINE_GRACE_MS && (
                          <div className="text-[11px] text-yellow-500 mt-0.5">
                            idle {shortDuration(r.idleMs)}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-500 whitespace-nowrap">
                        <div title={dateTime(r.startedAt)}>started {timeAgo(r.startedAt)}</div>
                        {r.submittedAt && (
                          <div className="text-gray-600" title={dateTime(r.submittedAt)}>
                            ended {timeAgo(r.submittedAt)}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex gap-2 justify-end">
                          <Link
                            href={`/admin/sessions/${r.sessionId}`}
                            className="text-xs px-2.5 py-1 bg-purple-900/60 rounded hover:bg-purple-900 whitespace-nowrap"
                          >
                            Report
                          </Link>
                          <button
                            onClick={() => resetRun(r)}
                            disabled={busyId === r.sessionId}
                            title="Delete this run so the candidate can take the test again"
                            className="text-xs px-2.5 py-1 bg-gray-700 rounded hover:bg-red-900 disabled:opacity-40 whitespace-nowrap"
                          >
                            {busyId === r.sessionId ? "Clearing…" : "Reset"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {body && (
            <div className="px-4 pb-4">
              <Pagination
                page={body.pagination.page}
                totalPages={body.pagination.totalPages}
                total={body.pagination.total}
                onChange={setPage}
              />
            </div>
          )}
        </Panel>

        <p className="text-xs text-gray-600">
          Scores are running totals recomputed from each candidate&apos;s best submission per
          question, so a run in progress shows what it is worth right now.{" "}
          <strong>Highest final score</strong> sorts on the score frozen when a run ends, which puts
          anyone still working at the bottom. <strong>Reset</strong> deletes a run outright — that
          is what releases the one-attempt-per-account lock so someone can sit the test again.
        </p>
      </main>
    </div>
  );
}
