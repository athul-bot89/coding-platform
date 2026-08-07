"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { CodeEditor } from "@/components/CodeEditor";
import { getMonacoLanguage, LANGUAGE_NAMES } from "@/lib/languages";
import { ProctorGuard, requestFullscreen } from "@/components/ProctorGuard";
import { markdownToHtml } from "@/lib/markdown";

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
  const [selectedLang, setSelectedLang] = useState<number>(71);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [violations, setViolations] = useState<string[]>([]);
  const [testStarted, setTestStarted] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  useEffect(() => {
    if (session && slug) {
      fetch(`/api/problems/${slug}`)
        .then((r) => r.json())
        .then((data) => {
          setProblem(data);
          const langs = data.allowedLanguages.split(",").map(Number);
          setSelectedLang(langs[0]);
          if (data.starterCode[langs[0]]) {
            setCode(data.starterCode[langs[0]]);
          }
        });
    }
  }, [session, slug]);

  // Update code when language changes
  useEffect(() => {
    if (problem?.starterCode[selectedLang]) {
      setCode(problem.starterCode[selectedLang]);
    } else {
      setCode("");
    }
  }, [selectedLang, problem]);

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

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problemId: problem.id,
          languageId: selectedLang,
          sourceCode: code,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Submission failed");
        setSubmitting(false);
        return;
      }

      const { attemptId } = await res.json();

      // Poll for results
      const poll = async () => {
        const r = await fetch(`/api/attempts/${attemptId}`);
        const data: AttemptResult = await r.json();
        setResult(data);

        if (data.state === "running") {
          setTimeout(poll, 1500);
        } else {
          setSubmitting(false);
        }
      };

      setTimeout(poll, 1000);
    } catch (e) {
      setSubmitting(false);
      alert("Network error");
    }
  };

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

  const allowedLangs = problem.allowedLanguages.split(",").map(Number);

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
            onChange={(e) => setSelectedLang(Number(e.target.value))}
            className="bg-gray-700 text-sm px-3 py-1.5 rounded border border-gray-600"
          >
            {allowedLangs.map((id) => (
              <option key={id} value={id}>
                {LANGUAGE_NAMES[id] || `Language ${id}`}
              </option>
            ))}
          </select>
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
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — Problem description */}
        <div className="w-2/5 overflow-y-auto p-4 border-r border-gray-700">
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

        {/* Right panel — Editor + Results */}
        <div className="flex-1 flex flex-col">
          {/* Code editor */}
          <div className="flex-1 min-h-0">
            <CodeEditor
              language={getMonacoLanguage(selectedLang)}
              value={code}
              onChange={setCode}
            />
          </div>

          {/* Results panel */}
          {result && (
            <div className="h-48 overflow-y-auto border-t border-gray-700 bg-gray-800 p-3">
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
                {result.runs.map((run) => (
                  <div
                    key={run.ordinal}
                    className={`text-xs p-2 rounded flex items-center justify-between ${
                      run.statusId === 3
                        ? "bg-green-900/30 border border-green-700"
                        : run.statusId && run.statusId > 3
                        ? "bg-red-900/30 border border-red-700"
                        : "bg-gray-700"
                    }`}
                  >
                    <span>
                      Test #{run.ordinal} ({run.kind}):{" "}
                      {!run.statusId
                        ? "Pending..."
                        : run.statusId === 3
                        ? "✓ Accepted"
                        : run.statusId === 4
                        ? "✗ Wrong Answer"
                        : run.statusId === 5
                        ? "✗ Time Limit"
                        : run.statusId === 6
                        ? "✗ Compile Error"
                        : "✗ Runtime Error"}
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
              {result.runs
                .filter((r) => r.kind === "sample" && r.statusId && r.statusId > 3)
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
                    {r.statusId === 4 && r.stdout !== null && (
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
          )}
        </div>
      </div>
    </div>
  );
}

