"use client";

// The admin landing page: what is happening right now, then what happened.
//
// Live candidates come first and everything else reads as context around them —
// this is a proctored platform, and the question an admin opens it with during a
// test window is "who is in there and is anything going wrong".

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Bar,
  CopyButton,
  Empty,
  Panel,
  Score,
  SessionStateBadge,
  StatTile,
  WarningCount,
  clock,
  dateTime,
  percent,
  scoreColor,
  shortDuration,
  timeAgo,
  useTicker,
} from "@/components/AdminUI";
import { errorMessage, fetchJson, HttpError } from "@/lib/fetch-json";
import { EVENT_LABELS, ONLINE_GRACE_MS } from "@/lib/proctor-config";

interface LiveRow {
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  image: string | null;
  assessmentId: string;
  assessmentTitle: string;
  startedAt: string;
  endsAt: string;
  lastSeenAt: string;
  idleMs: number;
  violationCount: number;
  maxViolations: number;
  totalScore: number;
  maxScore: number;
  solvedCount: number;
  questionCount: number;
  submissionCount: number;
}

interface TestRow {
  id: string;
  title: string;
  isActive: boolean;
  durationMinutes: number;
  maxViolations: number;
  createdAt: string;
  joinUrl: string;
  questionCount: number;
  totalPoints: number;
  startedCount: number;
  inProgressCount: number;
  completedCount: number;
  flaggedCount: number;
  avgScorePct: number | null;
  lastStartedAt: string | null;
}

interface RecentRow {
  sessionId: string;
  candidateName: string;
  candidateEmail: string;
  assessmentId: string;
  assessmentTitle: string;
  state: string;
  totalScore: number;
  maxScore: number;
  violationCount: number;
  submittedAt: string | null;
  elapsedMs: number;
}

interface EventRow {
  id: string;
  event: string;
  detail: string | null;
  counted: boolean;
  createdAt: string;
  sessionId: string | null;
  candidateName: string | null;
  assessmentTitle: string | null;
}

interface Overview {
  serverNow: number;
  kpis: {
    liveNow: number;
    onlineNow: number;
    flaggedLive: number;
    openTests: number;
    totalTests: number;
    candidates: number;
    completed: number;
    sessionsToday: number;
    submissionsToday: number;
    flaggedTotal: number;
    avgScorePct: number | null;
    problemsTotal: number;
    problemsActive: number;
  };
  live: LiveRow[];
  tests: TestRow[];
  recent: RecentRow[];
  events: EventRow[];
}

/** Poll fast enough to invigilate; slow right down when there is nothing to watch. */
const REFRESH_LIVE_MS = 15_000;
const REFRESH_IDLE_MS = 60_000;

/** A countdown below this is the reason you are looking at the screen. */
const ENDING_SOON_MS = 5 * 60_000;
const HALFWAY_WARN_MS = 15 * 60_000;

export default function AdminOverviewPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [auto, setAuto] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // Countdowns run off the server's clock. A browser several minutes out would
  // otherwise show a candidate more or less time than they actually have.
  const skewRef = useRef(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const body = await fetchJson<Overview>("/api/admin/overview");
      skewRef.current = Date.now() - body.serverNow;
      setData({
        ...body,
        live: Array.isArray(body.live) ? body.live : [],
        tests: Array.isArray(body.tests) ? body.tests : [],
        recent: Array.isArray(body.recent) ? body.recent : [],
        events: Array.isArray(body.events) ? body.events : [],
      });
      setLoadedAt(Date.now());
      setError(null);
    } catch (err) {
      // The layout owns the admin gate, so a 401 or 403 here means this browser
      // just lost the role — let it redirect rather than showing a dead retry.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load the dashboard."));
    } finally {
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const anyLive = (data?.live.length ?? 0) > 0;

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, anyLive ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
    return () => clearInterval(t);
  }, [auto, anyLive, load]);

  // Only tick while something is actually counting down.
  useTicker(anyLive);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        {error ? (
          <div className="text-center">
            <p className="text-red-400 mb-3 text-sm">{error}</p>
            <button
              onClick={load}
              className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500" />
        )}
      </div>
    );
  }

  const { kpis } = data;
  const serverTime = () => Date.now() - skewRef.current;

  return (
    <div>
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 bg-gray-900 z-10">
        <div>
          <h1 className="text-xl font-bold">Overview</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {loadedAt ? `Updated ${timeAgo(new Date(loadedAt))}` : "Loading…"}
            {auto && ` · refreshing every ${anyLive ? REFRESH_LIVE_MS / 1000 : REFRESH_IDLE_MS / 1000}s`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer mr-2">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="w-3.5 h-3.5 accent-green-600"
            />
            Auto-refresh
          </label>
          <button
            onClick={load}
            disabled={refreshing}
            className="px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <Link
            href="/admin/assessments"
            className="px-3 py-1.5 bg-green-600 rounded text-xs font-medium hover:bg-green-700"
          >
            + New test
          </Link>
        </div>
      </header>

      <main className="p-6 space-y-6">
        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error} — showing the last successful load.
          </p>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatTile
            label="Taking a test now"
            value={kpis.liveNow}
            sub={kpis.liveNow > 0 ? `${kpis.onlineNow} responding` : "nobody in a test"}
            accent={kpis.liveNow > 0 ? "blue" : undefined}
            onClick={() => router.push("/admin/sessions?state=live")}
          />
          <StatTile
            label="Flagged runs"
            value={kpis.flaggedTotal}
            sub={kpis.flaggedLive > 0 ? `${kpis.flaggedLive} of them live` : "with ≥1 warning"}
            accent={kpis.flaggedTotal > 0 ? "red" : undefined}
            onClick={() => router.push("/admin/sessions?flagged=1")}
          />
          <StatTile
            label="Open tests"
            value={kpis.openTests}
            sub={`${kpis.totalTests} total`}
            accent="green"
            onClick={() => router.push("/admin/assessments")}
          />
          <StatTile
            label="Completed runs"
            value={kpis.completed}
            sub={`${kpis.candidates} candidate${kpis.candidates === 1 ? "" : "s"}`}
            onClick={() => router.push("/admin/sessions?state=finished")}
          />
          <StatTile
            label="Average score"
            value={kpis.avgScorePct === null ? "—" : `${kpis.avgScorePct}%`}
            sub="finished runs"
            accent={kpis.avgScorePct === null ? undefined : kpis.avgScorePct >= 60 ? "green" : "yellow"}
          />
          <StatTile
            label="Today"
            value={kpis.sessionsToday}
            sub={`${kpis.submissionsToday} submission${kpis.submissionsToday === 1 ? "" : "s"}`}
            onClick={() => router.push("/admin/submissions")}
          />
        </div>

        {/* Live monitor */}
        <Panel
          title="Live now"
          count={
            anyLive
              ? `${data.live.length} in a test · ${kpis.onlineNow} responding`
              : undefined
          }
          action={
            anyLive ? (
              <span className="flex items-center gap-1.5 text-xs text-blue-300">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                live
              </span>
            ) : null
          }
        >
          {!anyLive ? (
            <Empty>
              Nobody is taking a test right now. Share a test link and candidates appear here the
              moment they start.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">Candidate</th>
                    <th className="py-2 pr-3 font-medium">Test</th>
                    <th className="py-2 pr-3 font-medium w-40">Progress</th>
                    <th className="py-2 pr-3 font-medium text-right">Score</th>
                    <th className="py-2 pr-3 font-medium text-right">Time left</th>
                    <th className="py-2 pr-3 font-medium text-center">⚠</th>
                    <th className="py-2 pr-3 font-medium">Last seen</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {data.live.map((r) => {
                    const remaining = new Date(r.endsAt).getTime() - serverTime();
                    const idle = serverTime() - new Date(r.lastSeenAt).getTime();
                    const online = idle <= ONLINE_GRACE_MS;
                    return (
                      <tr
                        key={r.sessionId}
                        className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                      >
                        <td className="py-2.5 pl-4 pr-3">
                          <div className="font-medium truncate max-w-[14rem]">
                            {r.candidateName}
                          </div>
                          <div className="text-xs text-gray-500 truncate max-w-[14rem]">
                            {r.candidateEmail}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <Link
                            href={`/admin/assessments/${r.assessmentId}/leaderboard`}
                            className="text-xs text-gray-300 hover:text-white truncate block max-w-[12rem]"
                          >
                            {r.assessmentTitle}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="text-xs text-gray-400 mb-1">
                            {r.solvedCount}/{r.questionCount} solved ·{" "}
                            {r.submissionCount} submit{r.submissionCount === 1 ? "" : "s"}
                          </div>
                          <Bar value={r.solvedCount} max={r.questionCount} />
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <Score score={r.totalScore} max={r.maxScore} />
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <span
                            className={`font-mono text-sm ${
                              remaining <= ENDING_SOON_MS
                                ? "text-red-400 font-semibold"
                                : remaining <= HALFWAY_WARN_MS
                                ? "text-yellow-400"
                                : "text-gray-300"
                            }`}
                          >
                            {clock(remaining)}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-center">
                          <WarningCount count={r.violationCount} max={r.maxViolations} />
                        </td>
                        <td className="py-2.5 pr-3">
                          {online ? (
                            <span className="flex items-center gap-1.5 text-xs text-green-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                              online
                            </span>
                          ) : (
                            <span
                              className="text-xs text-yellow-500"
                              title={`Last heartbeat ${dateTime(r.lastSeenAt)}`}
                            >
                              idle {shortDuration(idle)}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          <Link
                            href={`/admin/sessions/${r.sessionId}`}
                            className="text-xs px-2.5 py-1 bg-purple-900/60 rounded hover:bg-purple-900 whitespace-nowrap"
                          >
                            Report
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Every test */}
        <Panel
          title="Tests"
          count={`${kpis.openTests} open · ${kpis.totalTests} total`}
          action={
            <Link href="/admin/assessments" className="text-xs text-gray-400 hover:text-white">
              Manage →
            </Link>
          }
        >
          {data.tests.length === 0 ? (
            <Empty>
              No tests yet.{" "}
              <Link href="/admin/assessments" className="text-green-400 hover:underline">
                Create one
              </Link>
              , add questions, then share its link.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">Test</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Shape</th>
                    <th className="py-2 pr-3 font-medium text-right">Live</th>
                    <th className="py-2 pr-3 font-medium text-right">Done</th>
                    <th className="py-2 pr-3 font-medium text-right">Flagged</th>
                    <th className="py-2 pr-3 font-medium text-right">Avg</th>
                    <th className="py-2 pr-3 font-medium">Last start</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {data.tests.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <Link
                          href={`/admin/assessments/${t.id}`}
                          className="font-medium hover:text-green-400 truncate block max-w-[16rem]"
                        >
                          {t.title}
                        </Link>
                        {t.questionCount === 0 && (
                          <span className="text-[11px] text-yellow-500">
                            no questions — link will not open
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            t.isActive
                              ? "bg-green-900 text-green-300"
                              : "bg-gray-700 text-gray-400"
                          }`}
                        >
                          {t.isActive ? "open" : "closed"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-400 whitespace-nowrap">
                        {t.questionCount}Q · {t.totalPoints} pts · {t.durationMinutes} min
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        {t.inProgressCount > 0 ? (
                          <span className="text-blue-400">{t.inProgressCount}</span>
                        ) : (
                          <span className="text-gray-600">0</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        <span className="text-gray-300">{t.completedCount}</span>
                        <span className="text-gray-600">/{t.startedCount}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        <span className={t.flaggedCount > 0 ? "text-red-400" : "text-gray-600"}>
                          {t.flaggedCount}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        {t.avgScorePct === null ? (
                          <span className="text-gray-600">—</span>
                        ) : (
                          <span className={scoreColor(t.avgScorePct)}>{t.avgScorePct}%</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-gray-500 whitespace-nowrap">
                        {t.lastStartedAt ? timeAgo(t.lastStartedAt) : "never"}
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex gap-2 justify-end">
                          <CopyButton text={t.joinUrl} />
                          <Link
                            href={`/admin/assessments/${t.id}/leaderboard`}
                            className="text-xs px-2.5 py-1 bg-purple-900/60 rounded hover:bg-purple-900 whitespace-nowrap"
                          >
                            Leaderboard
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Feeds */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Panel
            title="Recently finished"
            action={
              <Link href="/admin/sessions" className="text-xs text-gray-400 hover:text-white">
                All runs →
              </Link>
            }
          >
            {data.recent.length === 0 ? (
              <Empty>No completed runs yet.</Empty>
            ) : (
              <div className="divide-y divide-gray-700/60">
                {data.recent.map((r) => (
                  <Link
                    key={r.sessionId}
                    href={`/admin/sessions/${r.sessionId}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-900/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{r.candidateName}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {r.assessmentTitle} · {clock(r.elapsedMs)} · {timeAgo(r.submittedAt)}
                      </div>
                    </div>
                    {r.violationCount > 0 && (
                      <span className="text-xs text-red-400 font-mono shrink-0">
                        ⚠{r.violationCount}
                      </span>
                    )}
                    <div className="shrink-0 text-right">
                      <span className={`font-mono text-sm ${scoreColor(percent(r.totalScore, r.maxScore))}`}>
                        {r.totalScore}
                      </span>
                      <span className="text-gray-600 font-mono text-xs">/{r.maxScore}</span>
                    </div>
                    <div className="shrink-0">
                      <SessionStateBadge state={r.state} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Proctor log"
            count={`${kpis.flaggedTotal} run${kpis.flaggedTotal === 1 ? "" : "s"} with warnings`}
            action={
              <Link href="/admin/events" className="text-xs text-gray-400 hover:text-white">
                Full log →
              </Link>
            }
          >
            {data.events.length === 0 ? (
              <Empty>Nothing recorded. No blocked actions, no warnings.</Empty>
            ) : (
              <div className="divide-y divide-gray-700/60">
                {data.events.map((e) => {
                  const body = (
                    <>
                      <span
                        className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                          e.counted ? "bg-red-900 text-red-300" : "bg-gray-700 text-gray-300"
                        }`}
                      >
                        {EVENT_LABELS[e.event] ?? e.event}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{e.candidateName ?? "Unknown"}</div>
                        <div className="text-xs text-gray-500 truncate">
                          {e.assessmentTitle ?? "Outside a test"}
                          {e.detail ? ` · ${e.detail}` : ""}
                        </div>
                      </div>
                      <span className="text-xs text-gray-600 shrink-0">{timeAgo(e.createdAt)}</span>
                    </>
                  );
                  return e.sessionId ? (
                    <Link
                      key={e.id}
                      href={`/admin/sessions/${e.sessionId}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-900/40"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                      {body}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <p className="text-xs text-gray-600">
          Live scores are running totals recomputed from each candidate&apos;s best submission per
          question — the same rule the leaderboard settles on, so a position here never moves just
          because the run ended. Time left counts against the server&apos;s clock, not this
          browser&apos;s.
        </p>
      </main>
    </div>
  );
}
