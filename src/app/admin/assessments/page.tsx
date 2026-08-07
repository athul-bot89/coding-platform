"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { fetchJson, postJson, errorMessage, HttpError } from "@/lib/fetch-json";
import { DEFAULT_MAX_VIOLATIONS } from "@/lib/proctor-config";

interface AssessmentRow {
  id: string;
  title: string;
  durationMinutes: number;
  maxViolations: number;
  isActive: boolean;
  createdAt: string;
  questionCount: number;
  totalPoints: number;
  joinUrl: string;
  startedCount: number;
  completedCount: number;
}

export default function AssessmentsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    durationMinutes: 90,
    maxViolations: DEFAULT_MAX_VIOLATIONS,
    instructions: "",
  });

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const body = await fetchJson<AssessmentRow[]>("/api/admin/assessments");
      setRows(Array.isArray(body) ? body : []);
    } catch (err) {
      // The admin role cached in the session cookie can outlive the server's view
      // of it, so a 401 or 403 means this browser is no longer an admin.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.push(err.status === 401 ? "/" : "/problems");
        return;
      }
      setRows([]);
      setLoadError(errorMessage(err, "Could not load your tests."));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") load();
  }, [session, load]);

  const create = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = await postJson<{ id: string }>("/api/admin/assessments", form);
      if (!body?.id) throw new Error("The test was not created — try again.");
      // Left disabled on success: the editor is loading and a second click here
      // would create a duplicate test.
      router.push(`/admin/assessments/${body.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not create the test."));
      setSubmitting(false);
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
        <h1 className="text-2xl font-bold">
          Code<span className="text-green-500">Test</span>
          <span className="text-sm text-purple-400 ml-2">Tests</span>
        </h1>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/admin")}
            className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
          >
            Admin dashboard
          </button>
          <button
            onClick={() => setCreating((c) => !c)}
            className="px-4 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700"
          >
            {creating ? "Cancel" : "+ New test"}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-5xl">
        {creating && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 mb-6">
            <h2 className="font-semibold mb-4">Create a test</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <label className="md:col-span-3 block">
                <span className="text-xs text-gray-400 block mb-1">Title</span>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Backend Engineer — Screening"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 block mb-1">Duration (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={form.durationMinutes}
                  onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400 block mb-1">
                  Max warnings <span className="text-gray-600">(0 = never auto-submit)</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={form.maxViolations}
                  onChange={(e) => setForm({ ...form, maxViolations: Number(e.target.value) })}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label className="md:col-span-3 block">
                <span className="text-xs text-gray-400 block mb-1">
                  Instructions shown before starting (markdown, optional)
                </span>
                <textarea
                  rows={3}
                  value={form.instructions}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
                />
              </label>
            </div>
            {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
            <button
              onClick={create}
              disabled={submitting}
              className="px-5 py-2 bg-green-600 rounded font-medium text-sm hover:bg-green-700 disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create and add questions"}
            </button>
          </div>
        )}

        {loading ? (
          <p className="text-center py-12 text-gray-500">Loading…</p>
        ) : loadError ? (
          <div className="text-center py-16">
            <p className="text-sm text-red-400 mb-3">{loadError}</p>
            <button
              onClick={load}
              className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
            >
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="mb-2">No tests yet.</p>
            <p className="text-sm">Create one, add questions, then share its link.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((a) => (
              <button
                key={a.id}
                onClick={() => router.push(`/admin/assessments/${a.id}`)}
                className="w-full text-left bg-gray-800 border border-gray-700 rounded-xl p-4 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold truncate">{a.title}</h3>
                      {!a.isActive && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400">
                          closed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {a.questionCount} question{a.questionCount === 1 ? "" : "s"} ·{" "}
                      {a.totalPoints} pts · {a.durationMinutes} min ·{" "}
                      {a.maxViolations === 0 ? "no auto-submit" : `${a.maxViolations} warnings`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm">
                      <span className="text-green-400 font-mono">{a.completedCount}</span>
                      <span className="text-gray-600 font-mono">/{a.startedCount}</span>
                    </div>
                    <div className="text-xs text-gray-500">completed</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
