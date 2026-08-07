"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CodeEditor, EditChange } from "@/components/CodeEditor";
import { getMonacoLanguage, languageName } from "@/lib/languages";
import { ProctorGuard } from "@/components/ProctorGuard";
import { FullscreenGate } from "@/components/FullscreenGate";
import { MultiDisplayGate } from "@/components/MultiDisplayGate";
import { TestTimer } from "@/components/TestTimer";
import { markdownToHtml } from "@/lib/markdown";
import { statusLabel, isAccepted, isFailed, JUDGE0_WRONG_ANSWER } from "@/lib/judge0-status";
import { fetchJson, postJson, HttpError, errorMessage } from "@/lib/fetch-json";
import {
  HEARTBEAT_MS,
  DRAFT_SAVE_MS,
  METRICS_FLUSH_MS,
  BLOCKED_MESSAGES,
  BLOCKED_FALLBACK,
} from "@/lib/proctor-config";

/** Cadence of the grading poll, and how long it keeps asking before giving up. */
const POLL_INTERVAL_MS = 1500;
const POLL_BUDGET_MS = 90_000;

interface SessionProblem {
  index: number;
  id: string;
  title: string;
  description: string;
  difficulty: string;
  points: number;
  allowedLanguages: number[];
  timeLimitMs: number;
  memoryLimitKb: number;
  starterCode: Record<string, string>;
  sampleTestCases: { ordinal: number; stdin: string; expectedOutput: string }[];
  totalTestCount: number;
  submissionCount: number;
  solved: boolean;
  attempted: boolean;
  draft: { code: string; languageId: number } | null;
}

interface SessionData {
  id: string;
  title: string;
  candidateName: string;
  remainingMs: number;
  violationCount: number;
  maxViolations: number;
  problems: SessionProblem[];
}

interface RunResult {
  id: string;
  kind: string;
  state: string;
  score: number;
  maxScore: number;
  runs: {
    ordinal: number;
    kind: string;
    statusId: number | null;
    stdout: string | null;
    stderr: string | null;
    compileOutput: string | null;
    stdin: string | null;
    expectedOutput: string | null;
    timeS: number | null;
    memoryKb: number | null;
  }[];
}

interface MetricBuffer {
  keystrokes: number;
  charsTyped: number;
  activeMs: number;
  largestInsertion: number;
  bursts: { atMs: number; chars: number }[];
}

export default function SessionPage() {
  const router = useRouter();
  const sessionId = useParams().id as string;

  const [data, setData] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evicted, setEvicted] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editors, setEditors] = useState<Record<string, { code: string; languageId: number }>>({});
  const [results, setResults] = useState<Record<string, RunResult | null>>({});
  const [resultErrors, setResultErrors] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, "run" | "submit" | null>>({});
  const [violations, setViolations] = useState({ count: 0, max: 0 });
  const [deadline, setDeadline] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [ending, setEnding] = useState(false);

  const tabId = useMemo(
    () => Math.random().toString(36).slice(2) + Date.now().toString(36),
    []
  );

  const startedAt = useRef(Date.now());
  const metrics = useRef<Record<string, MetricBuffer>>({});
  const lastEditAt = useRef<Record<string, number>>({});
  const draftTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const endingRef = useRef(false);
  const unmounted = useRef(false);
  // Heartbeat state, read from refs so the interval never has to be rebuilt.
  const sessionReady = useRef(false);
  const evictedRef = useRef(false);

  const problems = data?.problems ?? [];
  const active = problems[activeIdx];

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  // The grading poll reschedules itself, so it has to be told when the screen is
  // gone; otherwise it keeps firing — and keeps setting state — long after
  // `router.replace` has sent the candidate to the completion page.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      for (const timer of Object.values(pollTimers.current)) clearTimeout(timer);
    };
  }, []);

  // ---- Ending the test ------------------------------------------------------

  const endTest = useCallback(
    async (reason: "manual" | "timeout" | "terminated") => {
      if (endingRef.current) return;
      endingRef.current = true;
      setEnding(true);

      try {
        if (reason !== "terminated") {
          await fetch(`/api/session/${sessionId}/finish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          });
        }
      } catch {
        // Server-side sweep finalizes it regardless.
      }

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      router.replace(`/session/${sessionId}/complete?reason=${reason}`);
    },
    [sessionId, router]
  );

  // ---- Proctor events -------------------------------------------------------

  const reportEvent = useCallback(
    async (event: string, detail?: string) => {
      try {
        const res = await fetch(`/api/session/${sessionId}/event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, detail }),
        });
        if (!res.ok) return;
        const body = await res.json();

        setViolations({ count: body.violationCount, max: body.maxViolations });

        if (body.terminated) {
          flash("Too many violations — your test has been submitted.");
          endTest("terminated");
          return;
        }

        // The server decides what counts; the message follows that, so a blocked
        // action is never dressed up as a warning.
        if (!body.counted) {
          flash(BLOCKED_MESSAGES[event] ?? BLOCKED_FALLBACK);
        } else if (event !== "fullscreen_exit") {
          // The fullscreen overlay already shows its own counter.
          flash(
            body.maxViolations > 0
              ? `Warning ${body.violationCount} of ${body.maxViolations} — this was recorded.`
              : "This action was recorded."
          );
        }
      } catch {
        // Never let a logging failure interfere with the test.
      }
    },
    [sessionId, flash, endTest]
  );

  // ---- Load ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/session/${sessionId}?tabId=${tabId}`);
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          if (body.ended) {
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
            return;
          }
          setLoadError(body.error || "Could not load this test.");
          return;
        }

        const payload = body as SessionData;
        setData(payload);
        sessionReady.current = true;
        setViolations({ count: payload.violationCount, max: payload.maxViolations });
        setDeadline(Date.now() + payload.remainingMs);

        const initial: Record<string, { code: string; languageId: number }> = {};
        for (const p of payload.problems) {
          const langId = p.draft?.languageId ?? p.allowedLanguages[0];
          initial[p.id] = {
            languageId: langId,
            code: p.draft?.code ?? p.starterCode[String(langId)] ?? "",
          };
        }
        setEditors(initial);
      } catch {
        if (!cancelled) setLoadError("Network error while loading the test.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, tabId, router]);

  // ---- Heartbeat: clock re-sync + duplicate-tab eviction --------------------

  // Established once, on mount, and gated on refs rather than on `data`. Listing
  // `data` here restarted the interval on every submission — `execute` replaces
  // the payload to bump submissionCount — so a candidate submitting faster than
  // HEARTBEAT_MS never completed a tick and never beat at all: stale lastSeenAt,
  // no clock re-sync, and no duplicate-tab eviction.
  useEffect(() => {
    const beat = async () => {
      if (!sessionReady.current || evictedRef.current || endingRef.current) return;

      try {
        const body = await postJson(`/api/session/${sessionId}/heartbeat`, { tabId });

        // The server clock is the only one that matters.
        setDeadline(Date.now() + body.remainingMs);
        setViolations({ count: body.violationCount, max: body.maxViolations });
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 409 && err.body?.evicted) {
            evictedRef.current = true;
            setEvicted(true);
            return;
          }
          if (err.body?.ended && !endingRef.current) {
            endingRef.current = true;
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
          }
          return;
        }
        // Offline; the next beat re-syncs.
      }
    };

    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, tabId, router]);

  // ---- Draft autosave -------------------------------------------------------

  const saveDraft = useCallback(
    (problemId: string, code: string, languageId: number) => {
      clearTimeout(draftTimers.current[problemId]);
      draftTimers.current[problemId] = setTimeout(() => {
        fetch(`/api/session/${sessionId}/draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problemId, code, languageId }),
        }).catch(() => {});
      }, DRAFT_SAVE_MS);
    },
    [sessionId]
  );

  // ---- Typing metrics -------------------------------------------------------

  const flushMetrics = useCallback(
    (problemId?: string) => {
      const ids = problemId ? [problemId] : Object.keys(metrics.current);
      for (const id of ids) {
        const buf = metrics.current[id];
        if (!buf || (buf.keystrokes === 0 && buf.bursts.length === 0)) continue;

        // The window is swapped out rather than cleared, so keystrokes landing
        // while the POST is in flight accumulate in the fresh buffer and can't be
        // sent twice. If the POST never lands the unsent window is merged back:
        // an offline blip must not silently erase a window's paste evidence.
        metrics.current[id] = emptyBuffer();
        postJson(`/api/session/${sessionId}/metrics`, { problemId: id, ...buf }).catch(() => {
          mergeBuffer((metrics.current[id] ||= emptyBuffer()), buf);
        });
      }
    },
    [sessionId]
  );

  useEffect(() => {
    const id = setInterval(() => flushMetrics(), METRICS_FLUSH_MS);
    return () => clearInterval(id);
  }, [flushMetrics]);

  const handleEdit = useCallback((problemId: string, change: EditChange) => {
    const buf = (metrics.current[problemId] ||= emptyBuffer());
    const now = Date.now();

    buf.keystrokes += 1;
    buf.charsTyped += change.chars;
    buf.largestInsertion = Math.max(buf.largestInsertion, change.chars);

    // Only count gaps under 5s as active typing; anything longer is thinking
    // time (or time away) and shouldn't inflate the effort estimate.
    const gap = now - (lastEditAt.current[problemId] ?? now);
    if (gap > 0 && gap < 5000) buf.activeMs += gap;
    lastEditAt.current[problemId] = now;

    if (change.isBurst) {
      buf.bursts.push({ atMs: now - startedAt.current, chars: change.chars });
    }
  }, []);

  // ---- Editing --------------------------------------------------------------

  const updateCode = useCallback(
    (problemId: string, code: string) => {
      setEditors((prev) => {
        const cur = prev[problemId];
        if (!cur || cur.code === code) return prev;
        saveDraft(problemId, code, cur.languageId);
        return { ...prev, [problemId]: { ...cur, code } };
      });
    },
    [saveDraft]
  );

  const changeLanguage = useCallback(
    (problem: SessionProblem, languageId: number) => {
      setEditors((prev) => {
        const cur = prev[problem.id];
        const untouched = !cur?.code?.trim() || cur.code === problem.starterCode[String(cur.languageId)];
        const code = untouched ? problem.starterCode[String(languageId)] ?? "" : cur.code;
        saveDraft(problem.id, code, languageId);
        return { ...prev, [problem.id]: { code, languageId } };
      });
    },
    [saveDraft]
  );

  const switchQuestion = useCallback(
    (index: number) => {
      if (active) flushMetrics(active.id);
      setActiveIdx(index);
    },
    [active, flushMetrics]
  );

  // ---- Run / Submit ---------------------------------------------------------

  const execute = useCallback(
    async (problem: SessionProblem, kind: "run" | "submit") => {
      if (busy[problem.id]) return;
      const editor = editors[problem.id];
      if (!editor?.code.trim()) {
        flash("Write some code first.");
        return;
      }

      setBusy((b) => ({ ...b, [problem.id]: kind }));
      setResults((r) => ({ ...r, [problem.id]: null }));
      setResultErrors((e) => ({ ...e, [problem.id]: null }));
      flushMetrics(problem.id);

      const giveUp = (message: string) => {
        setBusy((b) => ({ ...b, [problem.id]: null }));
        setResultErrors((e) => ({ ...e, [problem.id]: message }));
      };

      try {
        const res = await fetch(`/api/session/${sessionId}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            problemId: problem.id,
            languageId: editor.languageId,
            sourceCode: editor.code,
            kind,
          }),
        });
        const body = await res.json();

        if (!res.ok) {
          if (body.ended && !endingRef.current) {
            endingRef.current = true;
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
            return;
          }
          flash(body.error || "Submission failed.");
          setBusy((b) => ({ ...b, [problem.id]: null }));
          return;
        }

        const pollUntil = Date.now() + POLL_BUDGET_MS;

        const poll = async () => {
          if (unmounted.current || endingRef.current) return;

          try {
            // fetchJson throws on a non-2xx. Storing the parsed body unchecked used
            // to turn an expired cookie into `{ error: "Unauthorized" }` sitting in
            // `results`, which stopped the polling and then took the whole test
            // screen down the moment the panel tried to read `.runs` off it.
            const result = await fetchJson<RunResult>(`/api/attempts/${body.attemptId}`);
            if (unmounted.current || endingRef.current) return;

            setResults((prev) => ({ ...prev, [problem.id]: result }));

            if (result.state === "running" || result.state === "queued") {
              // Judge0 can leave an attempt running indefinitely; polling for the
              // rest of the test only burns requests. Whatever is still in flight is
              // drained server-side when the session is finalized.
              if (Date.now() > pollUntil) {
                giveUp(
                  "Still grading — this is taking longer than usual. Your submission is saved and will still be scored; you can keep working."
                );
                return;
              }
              pollTimers.current[problem.id] = setTimeout(poll, POLL_INTERVAL_MS);
              return;
            }

            setBusy((b) => ({ ...b, [problem.id]: null }));

            if (kind === "submit") {
              const passed = result.maxScore > 0 && result.score === result.maxScore;
              setData((d) =>
                d
                  ? {
                      ...d,
                      problems: d.problems.map((p) =>
                        p.id === problem.id
                          ? {
                              ...p,
                              submissionCount: p.submissionCount + 1,
                              attempted: true,
                              solved: p.solved || passed,
                            }
                          : p
                      ),
                    }
                  : d
              );
            }
          } catch (err) {
            if (unmounted.current || endingRef.current) return;
            giveUp(gradingError(err));
          }
        };

        clearTimeout(pollTimers.current[problem.id]);
        pollTimers.current[problem.id] = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        setBusy((b) => ({ ...b, [problem.id]: null }));
        flash("Network error.");
      }
    },
    [busy, editors, sessionId, flash, flushMetrics, router]
  );

  const handleExpire = useCallback(() => {
    flushMetrics();
    endTest("timeout");
  }, [flushMetrics, endTest]);

  // ---- Non-test states ------------------------------------------------------

  if (evicted) {
    return (
      <Centered>
        <div className="text-4xl mb-4">🪟</div>
        <h1 className="text-xl font-semibold mb-2">Opened in another window</h1>
        <p className="text-sm text-gray-400">
          This test is now running in a different tab. Only one window can be open at a time —
          continue in the newest one.
        </p>
      </Centered>
    );
  }

  if (loadError) {
    return (
      <Centered>
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold mb-2">Can&apos;t open this test</h1>
        <p className="text-sm text-gray-400">{loadError}</p>
      </Centered>
    );
  }

  if (!data || deadline === null) {
    return (
      <Centered>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500 mx-auto" />
      </Centered>
    );
  }

  // The payload loaded but there is no question to show — an assessment with its
  // problems removed, or an index that no longer exists. A spinner here would pin
  // the candidate for the rest of their timed test with no way out, so say what
  // happened and leave the exit open.
  if (!active) {
    return (
      <Centered>
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold mb-2">No question to show</h1>
        <p className="text-sm text-gray-400 mb-2">
          {problems.length === 0
            ? "This test has no questions assigned to it, so there is nothing here to solve."
            : "The question you were on is no longer part of this test."}
        </p>
        <p className="text-sm text-gray-400 mb-5">
          This is not something you did — please tell whoever invited you. You can finish now
          instead of waiting out the clock.
        </p>
        <div className="flex gap-3">
          {problems.length > 0 && (
            <button
              onClick={() => setActiveIdx(0)}
              className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
            >
              Back to question 1
            </button>
          )}
          <button
            onClick={() => {
              flushMetrics();
              endTest("manual");
            }}
            disabled={ending}
            className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {ending ? "Submitting…" : "Finish test"}
          </button>
        </div>
      </Centered>
    );
  }

  const editor = editors[active.id] ?? { code: "", languageId: active.allowedLanguages[0] };
  const result = results[active.id];
  const resultError = resultErrors[active.id] ?? null;
  const activeBusy = busy[active.id];
  const solvedCount = problems.filter((p) => p.solved).length;

  return (
    <>
      <ProctorGuard onEvent={reportEvent} enabled={!ending} />

      <MultiDisplayGate>
      <FullscreenGate violationCount={violations.count} maxViolations={violations.max}>
        <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden no-select">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="font-semibold truncate">{data.title}</h1>
              <span className="text-xs text-gray-500 shrink-0">{data.candidateName}</span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {violations.max > 0 && violations.count > 0 && (
                <span className="text-xs px-2 py-1 rounded bg-red-950 text-red-300 border border-red-900">
                  ⚠ {violations.count}/{violations.max} warnings
                </span>
              )}
              <TestTimer deadline={deadline} onExpire={handleExpire} />
              <button
                onClick={() => setConfirmFinish(true)}
                disabled={ending}
                className="px-4 py-2 bg-red-600 rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                Finish test
              </button>
            </div>
          </header>

          <div className="flex flex-1 overflow-hidden">
            {/* Question rail */}
            <nav className="w-16 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-3 gap-2 shrink-0">
              {problems.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => switchQuestion(i)}
                  title={`${p.title} — ${p.points} pts`}
                  className={`w-11 h-11 rounded-lg text-sm font-semibold border transition-colors relative ${
                    i === activeIdx
                      ? "bg-green-600 border-green-500 text-white"
                      : p.solved
                      ? "bg-green-950 border-green-800 text-green-400 hover:bg-green-900"
                      : p.attempted
                      ? "bg-gray-800 border-yellow-800 text-yellow-400 hover:bg-gray-700"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  Q{i + 1}
                  {p.solved && i !== activeIdx && (
                    <span className="absolute -top-1 -right-1 text-[10px] bg-green-600 rounded-full w-4 h-4 flex items-center justify-center">
                      ✓
                    </span>
                  )}
                </button>
              ))}
              <div className="mt-auto text-[10px] text-gray-600 text-center leading-tight">
                {solvedCount}/{problems.length}
                <br />
                solved
              </div>
            </nav>

            {/* Problem statement */}
            <div className="w-2/5 overflow-y-auto border-r border-gray-700 p-4">
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-semibold">{active.title}</h2>
                <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400">
                  {active.points} pts
                </span>
                <span
                  className={`text-xs ${
                    active.difficulty === "easy"
                      ? "text-green-400"
                      : active.difficulty === "hard"
                      ? "text-red-400"
                      : "text-yellow-400"
                  }`}
                >
                  {active.difficulty}
                </span>
              </div>

              <div
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(active.description) }}
              />

              {active.sampleTestCases.length > 0 && (
                <div className="mt-6 space-y-3">
                  <h3 className="font-semibold text-sm text-gray-300">Sample cases</h3>
                  {active.sampleTestCases.map((tc) => (
                    <div key={tc.ordinal} className="bg-gray-800 p-3 rounded text-xs">
                      <div className="text-gray-400 mb-1">Input</div>
                      <pre className="bg-gray-900 p-2 rounded mb-2 whitespace-pre-wrap">{tc.stdin}</pre>
                      <div className="text-gray-400 mb-1">Expected output</div>
                      <pre className="bg-gray-900 p-2 rounded whitespace-pre-wrap">{tc.expectedOutput}</pre>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-6 text-xs text-gray-600">
                {active.totalTestCount} test cases · {active.timeLimitMs}ms CPU ·{" "}
                {Math.round(active.memoryLimitKb / 1024)}MB
                {active.submissionCount > 0 && ` · ${active.submissionCount} submission(s)`}
              </p>
            </div>

            {/* Editor + results */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
                <select
                  value={editor.languageId}
                  onChange={(e) => changeLanguage(active, Number(e.target.value))}
                  className="bg-gray-700 text-sm px-3 py-1.5 rounded border border-gray-600"
                >
                  {active.allowedLanguages.map((id) => (
                    <option key={id} value={id}>
                      {languageName(id)}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => execute(active, "run")}
                    disabled={!!activeBusy}
                    className="px-4 py-1.5 bg-gray-700 rounded text-sm font-medium hover:bg-gray-600 disabled:opacity-50"
                  >
                    {activeBusy === "run" ? "Running…" : "Run samples"}
                  </button>
                  <button
                    onClick={() => execute(active, "submit")}
                    disabled={!!activeBusy}
                    className="px-5 py-1.5 bg-green-600 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {activeBusy === "submit" ? "Submitting…" : "Submit"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0">
                <CodeEditor
                  key={active.id}
                  language={getMonacoLanguage(editor.languageId)}
                  value={editor.code}
                  onChange={(code) => updateCode(active.id, code)}
                  proctored
                  onEdit={(change) => handleEdit(active.id, change)}
                  onBlocked={reportEvent}
                />
              </div>

              <ResultsPanel result={result} error={resultError} busy={!!activeBusy} />
            </div>
          </div>
        </div>
      </FullscreenGate>
      </MultiDisplayGate>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[110] bg-red-600 text-white px-5 py-3 rounded-lg shadow-xl text-sm font-medium">
          ⚠️ {toast}
        </div>
      )}

      {/* Finish confirmation */}
      {confirmFinish && (
        <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">Finish the test?</h2>
            <p className="text-sm text-gray-400 mb-4">
              You have solved <strong className="text-white">{solvedCount}</strong> of{" "}
              <strong className="text-white">{problems.length}</strong> questions. Once you finish
              you cannot return, even if time remains.
            </p>
            {problems.some((p) => !p.attempted) && (
              <p className="text-sm text-yellow-400 bg-yellow-950/40 rounded px-3 py-2 mb-4">
                {problems.filter((p) => !p.attempted).length} question(s) have no submission yet.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmFinish(false)}
                className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
              >
                Keep working
              </button>
              <button
                onClick={() => {
                  flushMetrics();
                  endTest("manual");
                }}
                disabled={ending}
                className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {ending ? "Submitting…" : "Finish test"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function emptyBuffer(): MetricBuffer {
  return { keystrokes: 0, charsTyped: 0, activeMs: 0, largestInsertion: 0, bursts: [] };
}

/**
 * Candidate-facing copy for a grading poll that couldn't be completed. Nothing
 * here is lost work: `finalizeSession` drains every still-running attempt when
 * the test ends, so an unwatched submission is still scored.
 */
function gradingError(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return "You were signed out while this was grading. Your submission is saved and will still be scored — reload this page to carry on.";
  }
  if (err instanceof HttpError) {
    return `${errorMessage(err, "The judge could not be reached")}. Your submission is saved and will still be scored.`;
  }
  return "Lost connection while grading. Your submission is saved and will still be scored — check your connection and submit again if you want to see the result.";
}

/** Fold a window that failed to reach the server back into the live buffer. */
function mergeBuffer(into: MetricBuffer, unsent: MetricBuffer) {
  into.keystrokes += unsent.keystrokes;
  into.charsTyped += unsent.charsTyped;
  into.activeMs += unsent.activeMs;
  into.largestInsertion = Math.max(into.largestInsertion, unsent.largestInsertion);
  // The unsent bursts are the older ones, so they go in front.
  into.bursts = [...unsent.bursts, ...into.bursts];
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
      <div className="max-w-md text-center">{children}</div>
    </div>
  );
}

function ResultsPanel({
  result,
  error,
  busy,
}: {
  result: RunResult | null;
  error: string | null;
  busy: boolean;
}) {
  if (!result && !error && !busy) return null;

  // Defended rather than assumed: anything that reaches this panel without its
  // runs is a bug upstream, and it must not be allowed to throw and unmount the
  // test screen out from under a candidate mid-exam.
  const runs = result?.runs ?? [];
  const passedCount = runs.filter((r) => isAccepted(r.statusId)).length;

  return (
    <div className="h-56 overflow-y-auto border-t border-gray-700 bg-gray-800 p-3 shrink-0">
      {error && (
        <p className="text-sm text-yellow-300 bg-yellow-950/40 border border-yellow-900 rounded px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {!result && !error && <p className="text-sm text-gray-400">Sending to the judge…</p>}

      {result && (
        <>
          <div className="flex items-center gap-3 mb-3">
            <h3 className="font-semibold text-sm">
              {result.kind === "run" ? "Sample run" : "Submission"}
            </h3>
            {result.state === "done" ? (
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  result.score === result.maxScore ? "bg-green-600" : "bg-yellow-600"
                }`}
              >
                {/* score and maxScore are weighted point sums, so they cannot be read
                    out as a number of cases: three cases weighted 1/2/1 give a
                    maxScore of 4. The case count comes from the runs themselves. */}
                {passedCount}/{runs.length} tests passed · {result.score}/{result.maxScore} pts
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-600">
                {result.state === "error" ? "Judge error" : "Running…"}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {runs.map((r) => (
              <div
                key={r.ordinal}
                className={`text-xs px-2 py-1.5 rounded flex items-center justify-between ${
                  isAccepted(r.statusId)
                    ? "bg-green-900/30 border border-green-800"
                    : isFailed(r.statusId)
                    ? "bg-red-900/30 border border-red-800"
                    : "bg-gray-700"
                }`}
              >
                <span>
                  Test #{r.ordinal}
                  <span className="text-gray-500 ml-1">({r.kind})</span> —{" "}
                  {isAccepted(r.statusId) ? "✓ " : isFailed(r.statusId) ? "✗ " : ""}
                  {statusLabel(r.statusId)}
                </span>
                {r.timeS != null && (
                  <span className="text-gray-500">
                    {(r.timeS * 1000).toFixed(0)}ms · {r.memoryKb}KB
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Detail is shown for sample cases only — hidden cases stay hidden. */}
          {runs
            .filter((r) => r.kind === "sample" && isFailed(r.statusId))
            .map((r) => (
              <div key={`d-${r.ordinal}`} className="mt-2 bg-gray-900 rounded p-2 text-xs space-y-2">
                {r.compileOutput && (
                  <div>
                    <div className="text-red-400 mb-1">Compile error</div>
                    <pre className="whitespace-pre-wrap text-gray-300">{r.compileOutput}</pre>
                  </div>
                )}
                {r.stderr && (
                  <div>
                    <div className="text-red-400 mb-1">Stderr</div>
                    <pre className="whitespace-pre-wrap text-gray-300">{r.stderr}</pre>
                  </div>
                )}
                {r.statusId === JUDGE0_WRONG_ANSWER && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-yellow-400 mb-1">Your output</div>
                      <pre className="whitespace-pre-wrap text-gray-300">{r.stdout}</pre>
                    </div>
                    <div>
                      <div className="text-green-400 mb-1">Expected</div>
                      <pre className="whitespace-pre-wrap text-gray-300">{r.expectedOutput}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
