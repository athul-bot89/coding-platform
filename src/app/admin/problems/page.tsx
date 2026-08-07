"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchJson, postJson, errorMessage, HttpError } from "@/lib/fetch-json";
import { languageShortName } from "@/lib/languages";

interface ProblemSummary {
  id: string;
  title: string;
  slug: string;
  difficulty: string;
  isActive: boolean;
  allowedLanguages: string;
  timeLimitMs: number;
  createdAt: string;
  testCaseCount: number;
  sampleCount: number;
  hiddenCount: number;
  maxScore: number;
  attemptCount: number;
}

const DIFF_COLORS: Record<string, string> = {
  easy: "text-green-400",
  medium: "text-yellow-400",
  hard: "text-red-400",
};

export default function AdminProblemsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") loadProblems();
  }, [session]);

  const loadProblems = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ problems: ProblemSummary[] }>("/api/admin/problems");
      setProblems(data.problems ?? []);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.push(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, "Could not load problems."));
    } finally {
      setLoading(false);
    }
  };

  const toggleActive = async (id: string) => {
    try {
      await fetchJson(`/api/admin/problems/${id}`, { method: "DELETE" });
      loadProblems();
    } catch (err) {
      setError(errorMessage(err, "Could not toggle problem."));
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
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">
            Code<span className="text-green-500">Test</span>
            <span className="text-sm text-purple-400 ml-2">Problem Bank</span>
          </h1>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/admin/problems/new")}
            className="px-4 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700"
          >
            + New Problem
          </button>
          <button
            onClick={() => router.push("/admin")}
            className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
          >
            ← Admin Dashboard
          </button>
        </div>
      </header>

      <main className="p-6">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : error ? (
          <div className="max-w-md mx-auto text-center py-12">
            <p className="text-sm text-red-300 mb-4">{error}</p>
            <button onClick={loadProblems} className="px-4 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600">
              Retry
            </button>
          </div>
        ) : problems.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 mb-4">No problems yet.</p>
            <button
              onClick={() => router.push("/admin/problems/new")}
              className="px-6 py-3 bg-green-600 rounded-lg font-medium hover:bg-green-700"
            >
              Create Your First Problem
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">Title</th>
                  <th className="pb-3 pr-4">Slug</th>
                  <th className="pb-3 pr-4">Difficulty</th>
                  <th className="pb-3 pr-4">Languages</th>
                  <th className="pb-3 pr-4">Test Cases</th>
                  <th className="pb-3 pr-4">Max Score</th>
                  <th className="pb-3 pr-4">Attempts</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((p) => (
                  <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-3 pr-4 font-medium">{p.title}</td>
                    <td className="py-3 pr-4 text-gray-400 font-mono text-xs">{p.slug}</td>
                    <td className={`py-3 pr-4 capitalize ${DIFF_COLORS[p.difficulty] || ""}`}>
                      {p.difficulty}
                    </td>
                    <td className="py-3 pr-4 text-xs text-gray-300">
                      {p.allowedLanguages
                        .split(",")
                        .map((id) => languageShortName(Number(id)))
                        .join(", ")}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-blue-400">{p.sampleCount}s</span>
                      {" / "}
                      <span className="text-orange-400">{p.hiddenCount}h</span>
                    </td>
                    <td className="py-3 pr-4">{p.maxScore}</td>
                    <td className="py-3 pr-4">{p.attemptCount}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          p.isActive
                            ? "bg-green-900/50 text-green-400"
                            : "bg-red-900/50 text-red-400"
                        }`}
                      >
                        {p.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => router.push(`/admin/problems/${p.id}`)}
                          className="px-3 py-1 bg-blue-600 rounded text-xs hover:bg-blue-700"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => toggleActive(p.id)}
                          className={`px-3 py-1 rounded text-xs ${
                            p.isActive
                              ? "bg-orange-600 hover:bg-orange-700"
                              : "bg-green-600 hover:bg-green-700"
                          }`}
                        >
                          {p.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
