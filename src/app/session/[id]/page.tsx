"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CodeEditor, EditChange } from "@/components/CodeEditor";
import { getMonacoLanguage, languageName } from "@/lib/languages";
import { ProctorGuard } from "@/components/ProctorGuard";
import { FullscreenGate } from "@/components/FullscreenGate";
import { TestTimer } from "@/components/TestTimer";
import { markdownToHtml } from "@/lib/markdown";
import { statusLabel } from "@/lib/grading";
import { HEARTBEAT_MS, DRAFT_SAVE_MS, METRICS_FLUSH_MS } from "@/lib/proctor-config";

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
  const endingRef = useRef(false);

  const problems = data?.problems ?? [];
  const active = problems[activeIdx];

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
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

        if (event === "paste" || event === "copy" || event === "cut") {
          flash("Copy and paste are disabled in this test.");
        } else if (body.violationCount > 0 && event !== "fullscreen_exit") {
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

  useEffect(() => {
    if (!data || evicted) return;

    const beat = async () => {
      try {
        const res = await fetch(`/api/session/${sessionId}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId }),
        });
        const body = await res.json().catch(() => ({}));

        if (res.status === 409 && body.evicted) {
          setEvicted(true);
          return;
        }
        if (!res.ok) {
          if (body.ended && !endingRef.current) {
            endingRef.current = true;
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
          }
          return;
        }

        // The server clock is the only one that matters.
        setDeadline(Date.now() + body.remainingMs);
        setViolations({ count: body.violationCount, max: body.maxViolations });
      } catch {
        // Offline; the next beat re-syncs.
      }
    };

    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [data, evicted, sessionId, tabId, router]);

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
        metrics.current[id] = emptyBuffer();
        fetch(`/api/session/${sessionId}/metrics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problemId: id, ...buf }),
        }).catch(() => {});
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
      flushMetrics(problem.id);

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

        const poll = async () => {
          try {
            const r = await fetch(`/api/attempts/${body.attemptId}`);
            const result: RunResult = await r.json();
            setResults((prev) => ({ ...prev, [problem.id]: result }));

            if (result.state === "running" || result.state === "queued") {
              setTimeout(poll, 1500);
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
          } catch {
            setBusy((b) => ({ ...b, [problem.id]: null }));
            flash("Lost connection while grading. Try again.");
          }
        };

        setTimeout(poll, 1200);
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

  if (!data || !active || deadline === null) {
    return (
      <Centered>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500 mx-auto" />
      </Centered>
    );
  }

  const editor = editors[active.id] ?? { code: "", languageId: active.allowedLanguages[0] };
  const result = results[active.id];
  const activeBusy = busy[active.id];
  const solvedCount = problems.filter((p) => p.solved).length;

  return (
    <>
      <ProctorGuard onEvent={reportEvent} enabled={!ending} />

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

              <ResultsPanel result={result} busy={!!activeBusy} />
            </div>
          </div>
        </div>
      </FullscreenGate>

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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
      <div className="max-w-md text-center">{children}</div>
    </div>
  );
}

function ResultsPanel({ result, busy }: { result: RunResult | null; busy: boolean }) {
  if (!result && !busy) return null;

  return (
    <div className="h-56 overflow-y-auto border-t border-gray-700 bg-gray-800 p-3 shrink-0">
      {!result ? (
        <p className="text-sm text-gray-400">Sending to the judge…</p>
      ) : (
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
                {result.score}/{result.maxScore} test cases passed
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-600">
                {result.state === "error" ? "Judge error" : "Running…"}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {result.runs.map((r) => (
              <div
                key={r.ordinal}
                className={`text-xs px-2 py-1.5 rounded flex items-center justify-between ${
                  r.statusId === 3
                    ? "bg-green-900/30 border border-green-800"
                    : r.statusId && r.statusId > 3
                    ? "bg-red-900/30 border border-red-800"
                    : "bg-gray-700"
                }`}
              >
                <span>
                  Test #{r.ordinal}
                  <span className="text-gray-500 ml-1">({r.kind})</span> —{" "}
                  {r.statusId === 3 ? "✓ " : r.statusId ? "✗ " : ""}
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
          {result.runs
            .filter((r) => r.kind === "sample" && r.statusId && r.statusId > 3)
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
                {r.statusId === 4 && (
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
