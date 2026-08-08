"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchJson, postJson, errorMessage, HttpError } from "@/lib/fetch-json";
import {
  LANGUAGE_NAMES,
  ALL_LANGUAGE_IDS,
  DEFAULT_LANGUAGE_ID,
  defaultLanguageFor,
} from "@/lib/languages";

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

export default function EditProblemPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [allowedLanguages, setAllowedLanguages] = useState<number[]>([]);
  const [timeLimitMs, setTimeLimitMs] = useState(2000);
  const [memoryLimitKb, setMemoryLimitKb] = useState(128000);
  const [isActive, setIsActive] = useState(true);
  const [starterCode, setStarterCode] = useState<Record<string, string>>({});
  const [starterLang, setStarterLang] = useState(DEFAULT_LANGUAGE_ID);
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  const [testRunLang, setTestRunLang] = useState(DEFAULT_LANGUAGE_ID);
  const [testRunCode, setTestRunCode] = useState("");
  const [testRunResults, setTestRunResults] = useState<TestRunResponse | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin" && id) loadProblem();
  }, [session, id]);

  const loadProblem = async () => {
    setLoading(true);
    try {
      const p = await fetchJson<any>(`/api/admin/problems/${id}`);
      setTitle(p.title);
      setSlug(p.slug);
      setDescription(p.description);
      setDifficulty(p.difficulty);
      setAllowedLanguages(p.allowedLanguages);
      setTimeLimitMs(p.timeLimitMs);
      setMemoryLimitKb(p.memoryLimitKb);
      setIsActive(p.isActive);
      setStarterCode(p.starterCode || {});
      setTestCases(
        p.testCases.map((tc: any) => ({
          kind: tc.kind,
          stdin: tc.stdin,
          expectedOutput: tc.expectedOutput,
          weight: tc.weight,
        }))
      );
      if (p.allowedLanguages.length > 0) {
        const initial = defaultLanguageFor(p.allowedLanguages);
        setStarterLang(initial);
        setTestRunLang(initial);
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        router.push("/admin/problems");
        return;
      }
      setError(errorMessage(err, "Could not load problem"));
    } finally {
      setLoading(false);
    }
  };

  const toggleLanguage = (lid: number) => {
    setAllowedLanguages((prev) =>
      prev.includes(lid) ? prev.filter((l) => l !== lid) : [...prev, lid]
    );
  };

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

  const saveProblem = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await postJson(`/api/admin/problems/${id}`, {
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
      }, { method: "PATCH" });
      setSuccess("Problem updated!");
    } catch (err) {
      setError(errorMessage(err, "Could not save problem"));
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading" || loading) {
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
          <span className="text-sm text-purple-400">Edit Problem</span>
        </h1>
        <button
          onClick={() => router.push("/admin/problems")}
          className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
        >
          ← Back to Problem Bank
        </button>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        {/* ── BASIC INFO ── */}
        <section className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Basic Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Title</label>
              <input
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Slug</label>
              <input
                className="w-full bg-gray-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Difficulty</label>
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
                  min={500} max={30000} step={500}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Memory Limit (KB)</label>
                <input
                  type="number"
                  className="w-36 bg-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={memoryLimitKb}
                  onChange={(e) => setMemoryLimitKb(Number(e.target.value))}
                  min={1024} max={512000} step={1024}
                />
              </div>
              <div className="flex items-center gap-2 mt-5">
                <input
                  type="checkbox" id="isActive" checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)} className="accent-green-500"
                />
                <label htmlFor="isActive" className="text-sm text-gray-300">Active</label>
              </div>
            </div>
          </div>
        </section>

        {/* ── LANGUAGES ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Allowed Languages</h2>
          <div className="flex flex-wrap gap-3">
            {ALL_LANGUAGE_IDS.map((lid) => (
              <label
                key={lid}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm cursor-pointer border ${
                  allowedLanguages.includes(lid)
                    ? "border-green-500 bg-green-900/30 text-green-300"
                    : "border-gray-600 bg-gray-700 text-gray-400"
                }`}
              >
                <input
                  type="checkbox" checked={allowedLanguages.includes(lid)}
                  onChange={() => toggleLanguage(lid)} className="accent-green-500"
                />
                {LANGUAGE_NAMES[lid]}
              </label>
            ))}
          </div>
        </section>

        {/* ── DESCRIPTION ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Description (Markdown)</h2>
          <textarea
            className="w-full h-72 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </section>

        {/* ── TEST CASES ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Test Cases</h2>
            <button onClick={addTestCase} className="px-4 py-1.5 bg-green-600 rounded text-sm hover:bg-green-700">
              + Add Test Case
            </button>
          </div>
          <div className="space-y-4">
            {testCases.map((tc, idx) => (
              <div key={idx} className={`border rounded-lg p-4 space-y-3 ${
                tc.kind === "sample" ? "border-blue-600/50 bg-blue-900/10" : "border-orange-600/50 bg-orange-900/10"
              }`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    #{idx + 1}
                    <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                      tc.kind === "sample" ? "bg-blue-900/50 text-blue-400" : "bg-orange-900/50 text-orange-400"
                    }`}>{tc.kind}</span>
                  </span>
                  <div className="flex items-center gap-3">
                    <select className="bg-gray-700 rounded px-2 py-1 text-xs" value={tc.kind}
                      onChange={(e) => updateTestCase(idx, "kind", e.target.value)}>
                      <option value="sample">Sample (visible)</option>
                      <option value="hidden">Hidden (grading only)</option>
                    </select>
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-gray-400">Weight:</label>
                      <input type="number" className="w-16 bg-gray-700 rounded px-2 py-1 text-xs"
                        value={tc.weight} onChange={(e) => updateTestCase(idx, "weight", Math.max(1, Number(e.target.value)))}
                        min={1} max={100} />
                    </div>
                    {testCases.length > 1 && (
                      <button onClick={() => removeTestCase(idx)} className="text-red-400 hover:text-red-300 text-xs">
                        ✕ Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">stdin</label>
                    <textarea className="w-full h-24 bg-gray-900 rounded px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={tc.stdin} onChange={(e) => updateTestCase(idx, "stdin", e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Expected Output</label>
                    <textarea className="w-full h-24 bg-gray-900 rounded px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={tc.expectedOutput} onChange={(e) => updateTestCase(idx, "expectedOutput", e.target.value)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── STARTER CODE ── */}
        <section className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Starter Code (optional)</h2>
          <div className="flex gap-2 mb-3 flex-wrap">
            {allowedLanguages.map((lid) => (
              <button key={lid} onClick={() => setStarterLang(lid)}
                className={`px-3 py-1 rounded text-xs ${
                  starterLang === lid ? "bg-green-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}>{LANGUAGE_NAMES[lid]}</button>
            ))}
          </div>
          <textarea
            className="w-full h-40 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
            value={starterCode[String(starterLang)] ?? ""}
            onChange={(e) => setStarterCode((prev) => ({ ...prev, [String(starterLang)]: e.target.value }))}
          />
        </section>

        {/* ── TEST RUNNER ── */}
        <section className="bg-gray-800 border-2 border-green-700/50 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-green-400 mb-1">🧪 Test Runner — Verify All Test Cases</h2>
          <p className="text-xs text-gray-400 mb-4">Run a reference solution against <strong>all</strong> test cases at once.</p>
          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Language</label>
            <select className="w-64 bg-gray-700 rounded px-3 py-2 text-sm" value={testRunLang}
              onChange={(e) => setTestRunLang(Number(e.target.value))}>
              {allowedLanguages.map((lid) => (
                <option key={lid} value={lid}>{LANGUAGE_NAMES[lid]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Reference Solution</label>
            <textarea
              className="w-full h-48 bg-gray-900 rounded px-4 py-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-green-500"
              value={testRunCode} onChange={(e) => setTestRunCode(e.target.value)}
              placeholder="# Paste your reference solution here…"
            />
          </div>
          <button onClick={runAllTestCases} disabled={testRunning || !testRunCode.trim() || testCases.length === 0}
            className="mt-3 px-6 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">
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
                <div key={i} className={`rounded-lg p-3 text-sm border ${
                  r.passed ? "border-green-700/40 bg-green-900/10" : "border-red-700/40 bg-red-900/10"
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">
                      {r.passed ? "✅" : "❌"} Test Case #{r.testCase}
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                        testCases[i]?.kind === "sample"
                          ? "bg-blue-900/50 text-blue-400"
                          : "bg-orange-900/50 text-orange-400"
                      }`}>{testCases[i]?.kind ?? ""}</span>
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
        {error && <div className="bg-red-900/30 border border-red-600/50 rounded-lg px-4 py-3 text-sm text-red-300">{error}</div>}
        {success && <div className="bg-green-900/30 border border-green-600/50 rounded-lg px-4 py-3 text-sm text-green-300">{success}</div>}

        <div className="flex gap-4 pb-12">
          <button onClick={saveProblem} disabled={saving}
            className="px-8 py-3 bg-green-600 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50">
            {saving ? "Saving…" : "💾 Save Changes"}
          </button>
          <button onClick={() => router.push("/admin/problems")}
            className="px-6 py-3 bg-gray-700 rounded-lg text-sm hover:bg-gray-600">Cancel</button>
        </div>
      </main>
    </div>
  );
}
