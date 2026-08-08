"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { postJson, errorMessage, HttpError } from "@/lib/fetch-json";
import { LANGUAGE_NAMES, ALL_LANGUAGE_IDS, DEFAULT_LANGUAGE_ID } from "@/lib/languages";

interface TestCase {
  kind: "sample" | "hidden";
  stdin: string;
  expectedOutput: string;
  weight: number;
}

interface TestRunCaseResult {
  testCase: number;
  statusDescription: string;
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  time: string | null;
  memory: number | null;
  passed: boolean;
}

interface TestRunResponse {
  summary: { total: number; passed: number; failed: number; allPassed: boolean };
  details: TestRunCaseResult[];
}

export default function NewProblemPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  // Problem fields
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [allowedLanguages, setAllowedLanguages] = useState<number[]>([
    DEFAULT_LANGUAGE_ID,
    54,
    62,
    63,
  ]);
  const [timeLimitMs, setTimeLimitMs] = useState(2000);
  const [memoryLimitKb, setMemoryLimitKb] = useState(128000);
  const [isActive, setIsActive] = useState(true);

  // Starter code per language
  const [starterCode, setStarterCode] = useState<Record<string, string>>({});
  const [starterLang, setStarterLang] = useState(DEFAULT_LANGUAGE_ID);

  // Test cases
  const [testCases, setTestCases] = useState<TestCase[]>([
    { kind: "sample", stdin: "", expectedOutput: "", weight: 1 },
  ]);

  // Test runner state
  const [testRunLang, setTestRunLang] = useState(DEFAULT_LANGUAGE_ID);
  const [testRunCode, setTestRunCode] = useState("");
  const [testRunResults, setTestRunResults] = useState<TestRunResponse | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  // Form state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  // Auto-generate slug from title
  useEffect(() => {
    const s = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setSlug(s);
  }, [title]);

  const toggleLanguage = (id: number) => {
    setAllowedLanguages((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  };

  // Test case management
  const addTestCase = () => {
    setTestCases((prev) => [
      ...prev,
      { kind: "hidden", stdin: "", expectedOutput: "", weight: 1 },
    ]);
  };

  const removeTestCase = (idx: number) => {
    setTestCases((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateTestCase = (idx: number, field: keyof TestCase, value: any) => {
    setTestCases((prev) =>
      prev.map((tc, i) => (i === idx ? { ...tc, [field]: value } : tc))
    );
  };

  // Run ALL test cases against Judge0
  const runAllTestCases = async () => {
    setTestRunning(true);
    setTestRunResults(null);
    setError(null);
    if (testCases.length === 0) {
      setError("Add at least one test case first");
      setTestRunning(false);
      return;
    }
    try {
      const result = await postJson<TestRunResponse>("/api/admin/problems/test-run", {
        languageId: testRunLang,
        sourceCode: testRunCode,
        testCases: testCases.map((tc) => ({ stdin: tc.stdin, expectedOutput: tc.expectedOutput })),
        timeLimitMs,
        memoryLimitKb,
      });
      setTestRunResults(result);
    } catch (err) {
      setError(errorMessage(err, "Test run failed"));
    } finally {
      setTestRunning(false);
    }
  };

  // Save problem
  const saveProblem = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const body = {
        title,
        slug,
        description,
        difficulty,
        allowedLanguages,
        timeLimitMs,
        memoryLimitKb,
        starterCode: Object.keys(starterCode).length > 0 ? starterCode : null,
        isActive,
        testCases,
      };
      const result = await postJson<{ id: string; slug: string }>("/api/admin/problems", body);
      setSuccess(`Problem created! Slug: ${result.slug}`);
      setTimeout(() => router.push("/admin/problems"), 1500);
    } catch (err) {
      setError(errorMessage(err, "Could not save problem"));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between">
        <h1 className="flex items-center gap-2">
          <img src="https://www.botangelos.com/assets/img/Botangelos_white.png" alt="Botangelos" className="h-7" />
          <span className="text-sm text-purple-400">New Problem</span>
        </h1>
        <button
          onClick={() => router.push("/admin/problems")}
          className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
        >
          ← Back to Problem Bank
        </button>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        {/* ── GUIDE PANEL ── */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="w-full px-6 py-4 flex items-center justify-between text-left"
          >
            <span className="text-lg font-semibold text-green-400">
              📖 How to Write a Good Problem
            </span>
            <span className="text-gray-400">{showGuide ? "▼" : "►"}</span>
          </button>
          {showGuide && (
            <div className="px-6 pb-6 text-sm text-gray-300 space-y-4 border-t border-gray-700 pt-4">
              <div>
                <h3 className="font-semibold text-white mb-1">Title &amp; Slug</h3>
                <p>
                  Title: short, descriptive (e.g. &quot;Two Sum&quot;, &quot;FizzBuzz&quot;, &quot;Longest Substring&quot;).
                  The slug is auto-generated as a URL-safe version (e.g. <code className="text-green-400">two-sum</code>).
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">Description (Markdown)</h3>
                <p>Write the problem statement in Markdown. Follow this structure:</p>
                <pre className="bg-gray-900 rounded p-3 mt-2 text-xs overflow-x-auto text-green-300">{`## Problem Title

Brief description of what the candidate must do.

### Input
Describe the input format precisely.
- Line 1: what it contains
- Line 2: what it contains
- Mention data types and separators

### Output
Describe the exact output format.

### Constraints
- 1 ≤ N ≤ 10^5
- -10^9 ≤ values ≤ 10^9

### Example
**Input:**
\`\`\`
3 4
\`\`\`
**Output:**
\`\`\`
7
\`\`\``}</pre>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">Test Cases</h3>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    <strong className="text-blue-400">Sample</strong> test cases are shown to
                    candidates. Include 1–3 samples that demonstrate the I/O format.
                  </li>
                  <li>
                    <strong className="text-orange-400">Hidden</strong> test cases are only used
                    for grading. Include edge cases, large inputs, and boundary conditions.
                  </li>
                  <li>
                    <strong>Weight</strong> determines the points a test case is worth. Default is
                    1. Use higher weights for harder cases.
                  </li>
                  <li>
                    <strong>No trailing newline</strong> — the grader trims trailing whitespace,
                    but keep your expected output clean.
                  </li>
                  <li>
                    Aim for <strong>5–10 total test cases</strong>: 2 samples + 3–8 hidden.
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">Starter Code</h3>
                <p>
                  Optional boilerplate per language. Include I/O scaffolding so candidates can
                  start writing logic immediately. Use language-idiomatic I/O patterns (e.g.{" "}
                  <code className="text-green-400">input()</code> for Python,{" "}
                  <code className="text-green-400">Scanner</code> for Java).
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">Time &amp; Memory Limits</h3>
                <p>
                  Default: 2000ms / 128MB. Increase for problems with large input or complex
                  algorithms. If a brute-force solution should fail, keep limits tight.
                </p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">Testing Your Problem</h3>
                <p>
                  Use the <strong className="text-green-400">&quot;Test Runner&quot;</strong> panel below to paste a
                  reference solution and run it against each test case before publishing.
                  Every test case should pass with a correct solution.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── BASIC INFO ── */}
        <section className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Basic Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Title *</label>
              <input
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Two Sum"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Slug (auto-generated)</label>
              <input
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="two-sum"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Difficulty *</label>
              <select
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as any)}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div className="flex items-center gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Time Limit (ms)</label>
                <input
                  type="number"
                  className="w-32 bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={timeLimitMs}
                  onChange={(e) => setTimeLimitMs(Number(e.target.value))}
                  min={500}
                  max={30000}
                  step={500}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Memory Limit (KB)</label>
                <input
                  type="number"
                  className="w-36 bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={memoryLimitKb}
                  onChange={(e) => setMemoryLimitKb(Number(e.target.value))}
                  min={1024}
                  max={512000}
                  step={1024}
                />
              </div>
              <div className="flex items-center gap-2 mt-5">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="accent-green-500"
                />
                <label htmlFor="isActive" className="text-sm text-gray-300">
                  Active
                </label>
              </div>
            </div>
          </div>
        </section>

        {/* ── ALLOWED LANGUAGES ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Allowed Languages *</h2>
          <div className="flex flex-wrap gap-3">
            {ALL_LANGUAGE_IDS.map((id) => (
              <label
                key={id}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm cursor-pointer border ${
                  allowedLanguages.includes(id)
                    ? "border-green-500 bg-green-900/30 text-green-300"
                    : "border-gray-600 bg-gray-700 text-gray-400"
                }`}
              >
                <input
                  type="checkbox"
                  checked={allowedLanguages.includes(id)}
                  onChange={() => toggleLanguage(id)}
                  className="accent-green-500"
                />
                {LANGUAGE_NAMES[id]}
              </label>
            ))}
          </div>
        </section>

        {/* ── DESCRIPTION ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Description (Markdown) *</h2>
          <textarea
            className="w-full h-72 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={`## Problem Title\n\nDescribe the problem...\n\n### Input\nDescribe input format\n\n### Output\nDescribe output format\n\n### Constraints\n- 1 ≤ N ≤ 10^5\n\n### Example\n**Input:** \`3 4\`\n**Output:** \`7\``}
          />
        </section>

        {/* ── TEST CASES ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Test Cases *</h2>
            <button
              onClick={addTestCase}
              className="px-4 py-1.5 bg-green-600 rounded text-sm hover:bg-green-700"
            >
              + Add Test Case
            </button>
          </div>
          <div className="space-y-4">
            {testCases.map((tc, idx) => (
              <div
                key={idx}
                className={`border rounded-lg p-4 space-y-3 ${
                  tc.kind === "sample"
                    ? "border-blue-600/50 bg-blue-900/10"
                    : "border-orange-600/50 bg-orange-900/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Test Case #{idx + 1}
                    <span
                      className={`ml-2 px-2 py-0.5 rounded text-xs ${
                        tc.kind === "sample"
                          ? "bg-blue-900/50 text-blue-400"
                          : "bg-orange-900/50 text-orange-400"
                      }`}
                    >
                      {tc.kind}
                    </span>
                  </span>
                  <div className="flex items-center gap-3">
                    <select
                      className="bg-gray-700 rounded px-2 py-1 text-xs"
                      value={tc.kind}
                      onChange={(e) =>
                        updateTestCase(idx, "kind", e.target.value)
                      }
                    >
                      <option value="sample">Sample (visible)</option>
                      <option value="hidden">Hidden (grading only)</option>
                    </select>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-400">Weight:</label>
                      <input
                        type="number"
                        className="w-16 bg-gray-700 rounded px-2 py-1 text-xs"
                        value={tc.weight}
                        onChange={(e) =>
                          updateTestCase(idx, "weight", Math.max(1, Number(e.target.value)))
                        }
                        min={1}
                        max={100}
                      />
                    </div>
                    {testCases.length > 1 && (
                      <button
                        onClick={() => removeTestCase(idx)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        ✕ Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      stdin (input)
                    </label>
                    <textarea
                      className="w-full h-24 bg-gray-900 rounded px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={tc.stdin}
                      onChange={(e) =>
                        updateTestCase(idx, "stdin", e.target.value)
                      }
                      placeholder="3 4"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Expected Output
                    </label>
                    <textarea
                      className="w-full h-24 bg-gray-900 rounded px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={tc.expectedOutput}
                      onChange={(e) =>
                        updateTestCase(idx, "expectedOutput", e.target.value)
                      }
                      placeholder="7"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── STARTER CODE ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Starter Code (optional)</h2>
          <p className="text-xs text-gray-400 mb-3">
            Provide boilerplate code per language. Candidates see this when they open the problem.
          </p>
          <div className="flex gap-2 mb-3 flex-wrap">
            {allowedLanguages.map((id) => (
              <button
                key={id}
                onClick={() => setStarterLang(id)}
                className={`px-3 py-1 rounded text-xs ${
                  starterLang === id
                    ? "bg-green-600 text-white"
                    : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}
              >
                {LANGUAGE_NAMES[id]}
              </button>
            ))}
          </div>
          <textarea
            className="w-full h-40 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
            value={starterCode[String(starterLang)] ?? ""}
            onChange={(e) =>
              setStarterCode((prev) => ({
                ...prev,
                [String(starterLang)]: e.target.value,
              }))
            }
            placeholder={`// Starter code for ${LANGUAGE_NAMES[starterLang] ?? "this language"}…`}
          />
        </section>

        {/* ── TEST RUNNER ── */}
        <section className="bg-gray-800 border-2 border-green-700/50 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-green-400 mb-1">
            🧪 Test Runner — Verify All Test Cases Before Publishing
          </h2>
          <p className="text-xs text-gray-400 mb-4">
            Paste a reference solution below and run it against <strong>all</strong> test cases at once to confirm they work.
          </p>
          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Language</label>
            <select
              className="w-64 bg-gray-700 rounded px-3 py-2 text-sm"
              value={testRunLang}
              onChange={(e) => setTestRunLang(Number(e.target.value))}
            >
              {allowedLanguages.map((id) => (
                <option key={id} value={id}>
                  {LANGUAGE_NAMES[id]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Reference Solution</label>
            <textarea
              className="w-full h-48 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
              value={testRunCode}
              onChange={(e) => setTestRunCode(e.target.value)}
              placeholder="# Paste your reference / correct solution here…"
            />
          </div>
          <button
            onClick={runAllTestCases}
            disabled={testRunning || !testRunCode.trim() || testCases.length === 0}
            className="mt-3 px-6 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testRunning ? "Running all test cases…" : `▶ Run All ${testCases.length} Test Cases`}
          </button>

          {testRunResults && (
            <div className="mt-4 space-y-3">
              {/* Summary bar */}
              <div className={`rounded-lg px-4 py-3 flex items-center justify-between ${
                testRunResults.summary.allPassed
                  ? "bg-green-900/30 border border-green-600/50"
                  : "bg-red-900/30 border border-red-600/50"
              }`}>
                <div className="font-medium">
                  {testRunResults.summary.allPassed ? "✅ ALL PASSED" : "❌ SOME FAILED"}
                </div>
                <div className="text-sm">
                  <span className="text-green-400">{testRunResults.summary.passed} passed</span>
                  {testRunResults.summary.failed > 0 && (
                    <span className="text-red-400 ml-3">{testRunResults.summary.failed} failed</span>
                  )}
                  <span className="text-gray-400 ml-3">/ {testRunResults.summary.total} total</span>
                </div>
              </div>

              {/* Per-case results */}
              {testRunResults.details.map((r, i) => (
                <div
                  key={i}
                  className={`rounded-lg p-3 text-sm border ${
                    r.passed
                      ? "border-green-700/40 bg-green-900/10"
                      : "border-red-700/40 bg-red-900/10"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">
                      {r.passed ? "✅" : "❌"} Test Case #{r.testCase}
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                        testCases[i]?.kind === "sample"
                          ? "bg-blue-900/50 text-blue-400"
                          : "bg-orange-900/50 text-orange-400"
                      }`}>
                        {testCases[i]?.kind ?? ""}
                      </span>
                    </span>
                    <span className="text-xs text-gray-400">
                      {r.statusDescription} | {r.time ?? "—"}s | {r.memory ?? "—"} KB
                    </span>
                  </div>
                  {!r.passed && (
                    <div className="mt-2 space-y-1 text-xs">
                      {r.stdout != null && (
                        <div>
                          <span className="text-gray-400">Got:</span>
                          <pre className="bg-gray-900 rounded p-2 mt-0.5 overflow-x-auto">{r.stdout || "(empty)"}</pre>
                        </div>
                      )}
                      <div>
                        <span className="text-gray-400">Expected:</span>
                        <pre className="bg-gray-900 rounded p-2 mt-0.5 overflow-x-auto">{testCases[i]?.expectedOutput || "(empty)"}</pre>
                      </div>
                      {r.stderr && (
                        <div>
                          <span className="text-gray-400">stderr:</span>
                          <pre className="bg-gray-900 rounded p-2 mt-0.5 text-red-300 overflow-x-auto">{r.stderr}</pre>
                        </div>
                      )}
                      {r.compileOutput && (
                        <div>
                          <span className="text-gray-400">Compile:</span>
                          <pre className="bg-gray-900 rounded p-2 mt-0.5 text-yellow-300 overflow-x-auto">{r.compileOutput}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── SUBMIT ── */}
        {error && (
          <div className="bg-red-900/30 border border-red-600/50 rounded-lg px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-900/30 border border-green-600/50 rounded-lg px-4 py-3 text-sm text-green-300">
            {success}
          </div>
        )}

        <div className="flex gap-4 pb-12">
          <button
            onClick={saveProblem}
            disabled={saving}
            className="px-8 py-3 bg-green-600 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "💾 Create Problem"}
          </button>
          <button
            onClick={() => router.push("/admin/problems")}
            className="px-6 py-3 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
          >
            Cancel
          </button>
        </div>
      </main>
    </div>
  );
}
