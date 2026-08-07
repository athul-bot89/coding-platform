"use client";

// The proctoring log with everyone named.
//
// The old version printed a truncated user id and nothing else, which meant an
// admin could see that something happened but never who it happened to. Every
// row here names the candidate, says which test they were in, and links to the
// run report where the event sits on a timeline next to their code.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Empty, Pagination, Panel, dateTime, timeAgo } from "@/components/AdminUI";
import { errorMessage, fetchJson, HttpError } from "@/lib/fetch-json";
import { COUNTED_EVENTS, EVENT_LABELS, VALID_EVENTS } from "@/lib/proctor-config";

interface Row {
  id: string;
  userId: string;
  attemptId: string | null;
  sessionId: string | null;
  event: string;
  detail: string | null;
  counted: boolean;
  createdAt: string;
  candidateName: string | null;
  candidateEmail: string | null;
  assessmentId: string | null;
  assessmentTitle: string | null;
}

interface Body {
  events: Row[];
  counts: Record<string, number>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const countedSet = new Set<string>(COUNTED_EVENTS);

export default function AdminEventsPage() {
  const router = useRouter();

  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [event, setEvent] = useState("");
  const [countedOnly, setCountedOnly] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (event) params.set("event", event);
      if (countedOnly) params.set("counted", "1");

      const data = await fetchJson<Body>(`/api/admin/proctor-events?${params}`);
      setBody({ ...data, events: Array.isArray(data.events) ? data.events : [] });
      setError(null);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load the proctor log."));
    } finally {
      setLoading(false);
    }
  }, [router, page, event, countedOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const applyFilter = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const counts = body?.counts ?? {};
  const total = body?.pagination.total ?? 0;

  return (
    <div>
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 bg-gray-900 z-10">
        <div>
          <h1 className="text-xl font-bold">Proctor log</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Every detection, across every test. Warnings are the ones that count against a
            candidate&apos;s budget.
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
        {/* Event-type chips, each with its all-time count so you can see where the
            noise is before filtering to it. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => applyFilter(() => setEvent(""))}
            className={`text-xs px-2.5 py-1 rounded border ${
              event === ""
                ? "border-green-600 bg-gray-800 text-white"
                : "border-gray-700 bg-gray-800/50 text-gray-400 hover:text-gray-200"
            }`}
          >
            All
          </button>
          {VALID_EVENTS.map((e) => (
            <button
              key={e}
              onClick={() => applyFilter(() => setEvent(e))}
              className={`text-xs px-2.5 py-1 rounded border ${
                event === e
                  ? "border-green-600 bg-gray-800 text-white"
                  : "border-gray-700 bg-gray-800/50 text-gray-400 hover:text-gray-200"
              }`}
            >
              {EVENT_LABELS[e] ?? e}
              <span className="ml-1.5 text-gray-600">{counts[e] ?? 0}</span>
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer px-2">
            <input
              type="checkbox"
              checked={countedOnly}
              onChange={(e) => applyFilter(() => setCountedOnly(e.target.checked))}
              className="w-3.5 h-3.5 accent-red-600"
            />
            Warnings only
          </label>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        <Panel
          title="Events"
          count={body ? `${total.toLocaleString()} match${total === 1 ? "" : "es"}` : undefined}
        >
          {!body && loading ? (
            <Empty>Loading…</Empty>
          ) : body && body.events.length === 0 ? (
            <Empty>Nothing recorded for this filter.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Event</th>
                    <th className="py-2 pr-3 font-medium">Candidate</th>
                    <th className="py-2 pr-3 font-medium">Test</th>
                    <th className="py-2 pr-3 font-medium">Detail</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {(body?.events ?? []).map((e) => (
                    <tr
                      key={e.id}
                      className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                    >
                      <td
                        className="py-2.5 pl-4 pr-3 text-xs text-gray-500 whitespace-nowrap"
                        title={dateTime(e.createdAt)}
                      >
                        {timeAgo(e.createdAt)}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            e.counted
                              ? "bg-red-900 text-red-300"
                              : countedSet.has(e.event)
                              ? "bg-yellow-900/60 text-yellow-300"
                              : "bg-gray-700 text-gray-300"
                          }`}
                        >
                          {EVENT_LABELS[e.event] ?? e.event}
                        </span>
                        {e.counted && (
                          <span className="ml-1.5 text-[11px] text-red-400">warning</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="truncate max-w-[13rem]">{e.candidateName ?? "Unknown"}</div>
                        {e.candidateEmail && (
                          <div className="text-xs text-gray-500 truncate max-w-[13rem]">
                            {e.candidateEmail}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-400">
                        {e.assessmentTitle ? (
                          <span className="truncate block max-w-[11rem]">{e.assessmentTitle}</span>
                        ) : (
                          <span className="text-gray-600">outside a test</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-500 truncate max-w-[16rem]">
                        {e.detail || "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        {e.sessionId && (
                          <Link
                            href={`/admin/sessions/${e.sessionId}`}
                            className="text-xs px-2.5 py-1 bg-purple-900/60 rounded hover:bg-purple-900 whitespace-nowrap"
                          >
                            Report
                          </Link>
                        )}
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
          Leaving fullscreen, switching tab or window, and a second display are the detections that
          burn a warning. Copy, paste, right-click, DevTools, drag-drop and print are blocked and
          logged but never counted — the action did not happen, so nothing is held against the
          candidate for a reflex.
        </p>
      </main>
    </div>
  );
}
