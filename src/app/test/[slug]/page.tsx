"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import { CodeEditor } from "@/components/CodeEditor";
import {
  getMonacoLanguage,
  languageName,
  DEFAULT_LANGUAGE_ID,
  defaultLanguageFor,
} from "@/lib/languages";
import { ProctorGuard, requestFullscreen } from "@/components/ProctorGuard";
import { ResizeHandle } from "@/components/ResizeHandle";
import { EditorSettingsMenu } from "@/components/EditorSettingsMenu";
import { useEditorLayout, DEFAULT_LAYOUT, NUDGE_PCT, NUDGE_PX } from "@/lib/editor-layout";
import { markdownToHtml } from "@/lib/markdown";
import { fetchJson, postJson, errorMessage } from "@/lib/fetch-json";
import {
  JUDGE0_WRONG_ANSWER,
  isAccepted,
  isFailed,
  statusLabel,
} from "@/lib/judge0-status";

// Grading normally settles in seconds; the cap stops an attempt that Judge0 has
// silently dropped from polling for as long as the tab stays open.
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 80;

interface Problem {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  allowedLanguages: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  starterCode: Record<string, string>;
  sampleTestCases: { ordinal: number; stdin: string; expectedOutput: string }[];
}

interface AttemptResult {
  id: string;
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
    message: string | null;
    timeS: number | null;
    memoryKb: number | null;
    stdin: string | null;
    expectedOutput: string | null;
  }[];
}

export default function TestPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const slug = params.slug as string;

  const [problem, setProblem] = useState<Problem | null>(null);
  const [selectedLang, setSelectedLang] = useState<number>(DEFAULT_LANGUAGE_ID);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [violations, setViolations] = useState<string[]>([]);
  const [testStarted, setTestStarted] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Language the candidate picked but has not yet confirmed losing their code for.
  const [pendingLang, setPendingLang] = useState<number | null>(null);

  const mounted = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Panel sizing. Shared with the assessment screen, so a candidate who
  // sized one finds the other already the way they left it.
  const { layout, set: setLayout, reset: resetLayout } = useEditorLayout();
  const rowRef = useRef<HTMLDivElement>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  const dragSplit = useCallback(
    (clientX: number) => {
      const row = rowRef.current;
      const panel = problemRef.current;
      if (!row || !panel) return;
      const rowWidth = row.getBoundingClientRect().width;
      if (rowWidth <= 0) return;
      setLayout({ splitPct: ((clientX - panel.getBoundingClientRect().left) / rowWidth) * 100 });
    },
    [setLayout]
  );

  const dragResults = useCallback(
    (_clientX: number, clientY: number) => {
      const column = columnRef.current;
      if (!column) return;
      const rect = column.getBoundingClientRect();
      setLayout({ resultsPx: Math.min(rect.bottom - clientY, rect.height - 160) });
    },
    [setLayout]
  );

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  // A queued poll outlives the page unless it is cancelled here.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!session || !slug) return;
    let cancelled = false;

    (async () => {
      try {
        const data = await fetchJson<Problem>(`/api/problems/${slug}`);
        if (cancelled) return;

        const langs = parseLanguageIds(data.allowedLanguages);
        const initial = defaultLanguageFor(langs);

        setProblem(data);
        setSelectedLang(initial);
        setCode(data.starterCode?.[String(initial)] ?? "");
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load this problem."));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, slug]);

  // Nothing typed here is persisted anywhere, so an overwritten buffer is gone
  // for good: only reseed code the candidate never touched, leave it alone when
  // the new language ships no template, and ask before discarding real work.
  //
  // The ask is an in-page modal rather than window.confirm because every browser
  // drops the document out of fullscreen to show a native dialog, which
  // ProctorGuard then reports as a fullscreen_exit violation — a candidate would
  // be penalised for changing language. Switching is therefore deferred until
  // they answer: cancelling leaves both the language and the code untouched.
  const changeLanguage = (nextLang: number) => {
    if (!problem || nextLang === selectedLang) return;

    const starter = problem.starterCode?.[String(nextLang)] ?? "";
    const untouched =
      !code.trim() || code === (problem.starterCode?.[String(selectedLang)] ?? "");

    if (starter && !untouched) {
      setPendingLang(nextLang);
      return;
    }

    if (starter) setCode(starter);
    setSelectedLang(nextLang);
  };

  /** Carry out the switch the candidate just confirmed in the modal. */
  const applyPendingLang = () => {
    if (pendingLang === null) return;
    setCode(problem?.starterCode?.[String(pendingLang)] ?? "");
    setSelectedLang(pendingLang);
    setPendingLang(null);
  };

  /** Put the starter template for the selected language back in the editor. */
  const resetCode = () => {
    setCode(problem?.starterCode?.[String(selectedLang)] ?? "");
    setConfirmReset(false);
  };

  const handleStartTest = () => {
    requestFullscreen();
    setTestStarted(true);
  };

  const handleViolation = useCallback((event: string, detail?: string) => {
    setViolations((prev) => [...prev, `${event}${detail ? `: ${detail}` : ""}`]);
    setShowWarning(true);
    setTimeout(() => setShowWarning(false), 3000);
    // Practice runs are logged but not scored against anyone.
    fetch("/api/proctor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, detail }),
    }).catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (!problem || submitting) return;
    setSubmitting(true);
    setResult(null);
    setRunError(null);

    try {
      const { attemptId } = await postJson<{ attemptId: string }>("/api/submit", {
        problemId: problem.id,
        languageId: selectedLang,
        sourceCode: code,
      });

      let polls = 0;

      const poll = async () => {
        if (!mounted.current) return;

        try {
          const data = await fetchJson<AttemptResult>(`/api/attempts/${attemptId}`);
          if (!mounted.current) return;
          setResult(data);

          if (data.state === "running" || data.state === "queued") {
            if (++polls >= MAX_POLLS) {
              setRunError("The judge is still working on this. Submit again to retry.");
              setSubmitting(false);
              return;
            }
            pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
            return;
          }

          setSubmitting(false);
        } catch (err) {
          if (!mounted.current) return;
          setRunError(errorMessage(err, "Lost connection while grading."));
          setSubmitting(false);
        }
      };

      pollTimer.current = setTimeout(poll, 1000);
    } catch (err) {
      setRunError(errorMessage(err, "Submission failed."));
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-semibold mb-2">Can&apos;t open this problem</h1>
          <p className="text-sm text-gray-400">{loadError}</p>
          <button
            onClick={() => router.push("/problems")}
            className="mt-6 px-4 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            ← Back to problems
          </button>
        </div>
      </div>
    );
  }

  if (status === "loading" || !problem) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
      </div>
    );
  }

  // Pre-test screen — require fullscreen
  if (!testStarted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <div className="max-w-lg text-center p-8">
          <h1 className="text-3xl font-bold mb-4">{problem.title}</h1>
          <div className="bg-gray-800 p-6 rounded-lg mb-6 text-left">
            <h3 className="font-semibold mb-3 text-yellow-400">Test Rules:</h3>
            <ul className="space-y-2 text-sm text-gray-300">
              <li>• The test will run in <strong>fullscreen mode</strong></li>
              <li>• <strong>Copy/Paste is disabled</strong> outside the editor</li>
              <li>• Switching tabs or windows will be <strong>logged</strong></li>
              <li>• Right-click and DevTools are <strong>blocked</strong></li>
              <li>• All violations are recorded and visible to admin</li>
            </ul>
          </div>
          <button
            onClick={handleStartTest}
            className="px-8 py-4 bg-green-600 rounded-lg font-semibold text-lg hover:bg-green-700 transition-colors"
          >
            Start Test (Enter Fullscreen)
          </button>
          <button
            onClick={() => router.push("/problems")}
            className="block mx-auto mt-4 text-sm text-gray-500 hover:text-gray-300"
          >
            ← Back to problems
          </button>
        </div>
      </div>
    );
  }

  const allowedLangs = parseLanguageIds(problem.allowedLanguages);

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden no-select">
      <ProctorGuard onEvent={handleViolation} />

      {/* Warning toast */}
      {showWarning && (
        <div className="fixed top-4 right-4 z-50 bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg animate-pulse">
          ⚠️ Violation detected! This has been logged.
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold">{problem.title}</h1>
          <span className="text-xs text-gray-400">
            Time: {problem.timeLimitMs}ms | Memory: {Math.round(problem.memoryLimitKb / 1024)}MB
          </span>
        </div>
        <div className="flex items-center gap-3">
          {violations.length > 0 && (
            <span className="text-xs text-red-400">
              {violations.length} violation(s)
            </span>
          )}
          <select
            value={selectedLang}
            onChange={(e) => changeLanguage(Number(e.target.value))}
            className="bg-gray-700 text-sm px-3 py-1.5 rounded border border-gray-600"
          >
            {allowedLangs.map((id) => (
              <option key={id} value={id}>
                {languageName(id)}
              </option>
            ))}
          </select>
          <EditorSettingsMenu
            fontSize={layout.fontSize}
            onFontSize={(fontSize) => setLayout({ fontSize })}
            onResetLayout={resetLayout}
          />
          <button
            onClick={() => setConfirmReset(true)}
            disabled={submitting}
            title="Restore the starter template for this problem"
            className="px-3 py-1.5 bg-gray-700 rounded text-sm font-medium hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset code
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-1.5 bg-green-600 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Running..." : "Submit"}
          </button>
        </div>
      </header>

      {/* Main content */}
      <div ref={rowRef} className="flex flex-1 overflow-hidden">
        {/* Left panel — Problem description */}
        <div
          ref={problemRef}
          style={{ width: `${layout.splitPct}%` }}
          className="shrink-0 overflow-y-auto p-4"
        >
          <div className="prose prose-invert prose-sm max-w-none">
            <div dangerouslySetInnerHTML={{ __html: markdownToHtml(problem.description) }} />
          </div>

          {/* Sample test cases */}
          <div className="mt-6 space-y-3">
            <h3 className="font-semibold text-sm text-gray-300">Sample Test Cases:</h3>
            {problem.sampleTestCases.map((tc) => (
              <div key={tc.ordinal} className="bg-gray-800 p-3 rounded text-xs">
                <div className="mb-2">
                  <span className="text-gray-400">Input:</span>
                  <pre className="mt-1 bg-gray-900 p-2 rounded">{tc.stdin}</pre>
                </div>
                <div>
                  <span className="text-gray-400">Expected Output:</span>
                  <pre className="mt-1 bg-gray-900 p-2 rounded">{tc.expectedOutput}</pre>
                </div>
              </div>
            ))}
          </div>
        </div>

        <ResizeHandle
          axis="x"
          label="Resize the problem panel"
          onMove={dragSplit}
          onNudge={(steps) => setLayout({ splitPct: layout.splitPct + steps * NUDGE_PCT })}
          onReset={() => setLayout({ splitPct: DEFAULT_LAYOUT.splitPct })}
        />

        {/* Right panel — Editor + Results */}
        <div ref={columnRef} className="flex-1 flex flex-col min-w-0">
          {/* Code editor */}
          <div className="flex-1 min-h-0">
            <CodeEditor
              language={getMonacoLanguage(selectedLang)}
              value={code}
              onChange={setCode}
              fontSize={layout.fontSize}
            />
          </div>

          {runError && (
            <div className="border-t border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300 shrink-0">
              {runError}
            </div>
          )}

          {/* Results panel */}
          {result && (
            <>
            <ResizeHandle
              axis="y"
              label="Resize the results panel"
              onMove={dragResults}
              onNudge={(steps) => setLayout({ resultsPx: layout.resultsPx + steps * NUDGE_PX })}
              onReset={() => setLayout({ resultsPx: DEFAULT_LAYOUT.resultsPx })}
            />
            <div
              style={{ height: layout.resultsPx, maxHeight: "70%" }}
              className="shrink-0 overflow-y-auto bg-gray-800 p-3"
            >
              <div className="flex items-center gap-4 mb-3">
                <h3 className="font-semibold text-sm">
                  Results: {result.score}/{result.maxScore}
                </h3>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    result.state === "done"
                      ? result.score === result.maxScore
                        ? "bg-green-600"
                        : "bg-yellow-600"
                      : "bg-blue-600"
                  }`}
                >
                  {result.state === "running" ? "Running..." : result.state}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {(result.runs ?? []).map((run) => (
                  <div
                    key={run.ordinal}
                    className={`text-xs p-2 rounded flex items-center justify-between ${
                      isAccepted(run.statusId)
                        ? "bg-green-900/30 border border-green-700"
                        : isFailed(run.statusId)
                        ? "bg-red-900/30 border border-red-700"
                        : "bg-gray-700"
                    }`}
                  >
                    <span>
                      Test #{run.ordinal} ({run.kind}):{" "}
                      {isAccepted(run.statusId) ? "✓ " : isFailed(run.statusId) ? "✗ " : ""}
                      {statusLabel(run.statusId)}
                    </span>
                    {run.timeS && (
                      <span className="text-gray-400">
                        {(run.timeS * 1000).toFixed(0)}ms | {run.memoryKb}KB
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {/* Show error details for sample cases */}
              {(result.runs ?? [])
                .filter((r) => r.kind === "sample" && isFailed(r.statusId))
                .map((r) => (
                  <div key={`detail-${r.ordinal}`} className="mt-2 text-xs bg-gray-900 p-2 rounded">
                    {r.compileOutput && (
                      <div>
                        <span className="text-red-400">Compile Error:</span>
                        <pre className="mt-1 whitespace-pre-wrap">{r.compileOutput}</pre>
                      </div>
                    )}
                    {r.stderr && (
                      <div>
                        <span className="text-red-400">Stderr:</span>
                        <pre className="mt-1 whitespace-pre-wrap">{r.stderr}</pre>
                      </div>
                    )}
                    {r.statusId === JUDGE0_WRONG_ANSWER && r.stdout !== null && (
                      <div>
                        <span className="text-yellow-400">Your Output:</span>
                        <pre className="mt-1 whitespace-pre-wrap">{r.stdout}</pre>
                        <span className="text-green-400">Expected:</span>
                        <pre className="mt-1 whitespace-pre-wrap">{r.expectedOutput}</pre>
                      </div>
                    )}
                  </div>
                ))}
            </div>
            </>
          )}
        </div>
      </div>

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">⚠️ Reset your code?</h2>
            <p className="text-sm text-gray-400 mb-4">
              Everything you have written in{" "}
              <strong className="text-white">{languageName(selectedLang)}</strong> is discarded
              and the editor goes back to the starter template. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmReset(false)}
                className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={resetCode}
                className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700"
              >
                Reset code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Language switch confirmation */}
      {pendingLang !== null && (
        <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">
              ⚠️ Switch to {languageName(pendingLang)}?
            </h2>
            <p className="text-sm text-gray-400 mb-4">
              The editor loads the{" "}
              <strong className="text-white">{languageName(pendingLang)}</strong> starter
              template and everything you have written in{" "}
              <strong className="text-white">{languageName(selectedLang)}</strong> is
              discarded. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPendingLang(null)}
                className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={applyPendingLang}
                className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700"
              >
                Switch language
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The API stores allowed languages as a CSV string; drop anything unparseable. */
function parseLanguageIds(csv: string | undefined): number[] {
  return (csv ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0);
}

