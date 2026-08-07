"use client";

// The raw submission log — every graded run of code, proctored or practice.
//
// This is the level below a candidate's run: useful for chasing a grading
// failure or a Judge0 outage, not for judging a candidate. That is what the
// per-run report is for, and every proctored row links straight to it.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  Empty,
  Pagination,
  Panel,
  Score,
  dateTime,
  timeAgo,
} from "@/components/AdminUI";
import { errorMessage, fetchJson, HttpError } from "@/lib/fetch-json";
import { languageShortName } from "@/lib/languages";

interface Row {
  id: string;
  user: { id: string; name: string | null; email: string | null; image: string | null };
  problem: { id: string; title: string; slug: string };
  languageId: number;
  kind: string;
  state: string;
  score: number;
  maxScore: number;
  createdAt: string;
  finishedAt: string | null;
  sessionId: string | null;
  assessmentTitle: string | null;
  runsSummary: { total: number; passed: number; failed: number; pending: number };
}

interface Body {
  attempts: Row[];
  problems: { id: string; title: string }[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  { value: "done", label: "Done" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "error", label: "Error" },
];

const KIND_OPTIONS = [
  { value: "", label: "Runs and submits" },
  { value: "submit", label: "Submits only" },
  { value: "run", label: "Sample runs only" },
];

const SEARCH_DEBOUNCE_MS = 350;

export default function AdminSubmissionsPage() {
  const router = useRouter();

  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const [problemId, setProblemId] = useState("");
  const [proctored, setProctored] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "25" });
      if (debouncedQ) params.set("q", debouncedQ);
      if (state) params.set("state", state);
      if (kind) params.set("kind", kind);
      if (problemId) params.set("problemId", problemId);
      if (proctored) params.set("proctored", "1");

      const data = await fetchJson<Body>(`/api/admin/attempts?${params}`);
      setBody({ ...data, attempts: Array.isArray(data.attempts) ? data.attempts : [] });
      setError(null);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load submissions."));
    } finally {
      setLoading(false);
    }
  }, [router, page, debouncedQ, state, kind, problemId, proctored]);

  useEffect(() => {
    load();
  }, [load]);

  const applyFilter = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const total = body?.pagination.total ?? 0;
  const filtered = !!(debouncedQ || state || kind || problemId || proctored);

  return (
    <div>
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 bg-gray-900 z-10">
        <div>
          <h1 className="text-xl font-bold">Submissions</h1>
          <p className="text-xs text-gray-500 mt-0.5">Every graded execution, newest first</p>
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => applyFilter(() => setQ(e.target.value))}
            placeholder="Search name or email…"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-64"
          />
          <select
            value={problemId}
            onChange={(e) => applyFilter(() => setProblemId(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm max-w-[16rem]"
          >
            <option value="">All problems</option>
            {(body?.problems ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => applyFilter(() => setKind(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
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
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer px-2">
            <input
              type="checkbox"
              checked={proctored}
              onChange={(e) => applyFilter(() => setProctored(e.target.checked))}
              className="w-3.5 h-3.5 accent-green-600"
            />
            From a test only
          </label>
          {filtered && (
            <button
              onClick={() =>
                applyFilter(() => {
                  setQ("");
                  setDebouncedQ("");
                  setState("");
                  setKind("");
                  setProblemId("");
                  setProctored(false);
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
          title="Submissions"
          count={body ? `${total.toLocaleString()} match${total === 1 ? "" : "es"}` : undefined}
        >
          {!body && loading ? (
            <Empty>Loading…</Empty>
          ) : body && body.attempts.length === 0 ? (
            <Empty>{filtered ? "No submissions match these filters." : "No submissions yet."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">Candidate</th>
                    <th className="py-2 pr-3 font-medium">Problem</th>
                    <th className="py-2 pr-3 font-medium">Context</th>
                    <th className="py-2 pr-3 font-medium">Lang</th>
                    <th className="py-2 pr-3 font-medium text-right">Score</th>
                    <th className="py-2 pr-3 font-medium">Cases</th>
                    <th className="py-2 pr-3 font-medium">State</th>
                    <th className="py-2 pr-4 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {(body?.attempts ?? []).map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <div className="flex items-center gap-2">
                          {a.user.image && (
                            <img src={a.user.image} alt="" className="w-6 h-6 rounded-full shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[12rem]">
                              {a.user.name || "—"}
                            </div>
                            <div className="text-xs text-gray-500 truncate max-w-[12rem]">
                              {a.user.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 truncate max-w-[12rem]">{a.problem.title}</td>
                      <td className="py-2.5 pr-3">
                        {a.sessionId ? (
                          <Link
                            href={`/admin/sessions/${a.sessionId}`}
                            className="text-xs text-purple-300 hover:text-purple-200 truncate block max-w-[12rem]"
                            title={a.assessmentTitle ?? undefined}
                          >
                            {a.assessmentTitle ?? "Test run"} →
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-600">practice</span>
                        )}
                        {a.kind === "run" && (
                          <span className="text-[11px] text-gray-600">samples only</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-300">
                        {languageShortName(a.languageId)}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        <Score score={a.score} max={a.maxScore} />
                      </td>
                      <td className="py-2.5 pr-3 text-xs whitespace-nowrap">
                        <span className="text-green-400">{a.runsSummary.passed}✓</span>{" "}
                        <span className="text-red-400">{a.runsSummary.failed}✗</span>
                        {a.runsSummary.pending > 0 && (
                          <span className="text-gray-400"> {a.runsSummary.pending}⏳</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            a.state === "done"
                              ? "bg-green-900 text-green-300"
                              : a.state === "error"
                              ? "bg-red-900 text-red-300"
                              : "bg-blue-900 text-blue-300"
                          }`}
                        >
                          {a.state}
                        </span>
                      </td>
                      <td
                        className="py-2.5 pr-4 text-xs text-gray-500 whitespace-nowrap"
                        title={dateTime(a.createdAt)}
                      >
                        {timeAgo(a.createdAt)}
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
          Score here is the raw test-case weight of one execution. A candidate&apos;s points for a
          question are their <em>best</em> submission scaled to that question&apos;s value — open the
          run report to see how a total was reached.
        </p>
      </main>
    </div>
  );
}
