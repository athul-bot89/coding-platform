"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchJson, errorMessage } from "@/lib/fetch-json";

interface Problem {
  id: string;
  title: string;
  slug: string;
  difficulty: string;
}

export default function ProblemsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = (session?.user as any)?.role === "admin";

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  useEffect(() => {
    if (!session || (session.user as any)?.role !== "admin") return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<Problem[]>("/api/problems");
        // A body that isn't a list would take the render down on .map().
        if (!cancelled) setProblems(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load the problem list."));
      } finally {
        // Clearing this in `finally` is what keeps a failure from pinning the
        // user on the spinner with no way forward.
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, reloadKey]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
        <div className="max-w-md w-full bg-gray-800 border border-gray-700 rounded-xl p-8 text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-red-950 border border-red-900 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold">Access denied</h1>
          <p className="mt-2 text-sm text-gray-400">
            This page is only available to administrators.
          </p>
          {session?.user?.email && (
            <p className="mt-4 text-xs text-gray-500">
              Signed in as <span className="text-gray-300 break-all">{session.user.email}</span>
            </p>
          )}
          <div className="mt-6 flex flex-col gap-2">
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="w-full px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            >
              Sign in with a different account
            </button>
            <button
              onClick={() => router.push("/")}
              className="w-full px-4 py-2 rounded border border-gray-700 hover:bg-gray-700/40 text-sm text-gray-300"
            >
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
      </div>
    );
  }

  const difficultyColor = (d: string) => {
    switch (d) {
      case "easy": return "text-green-400";
      case "medium": return "text-yellow-400";
      case "hard": return "text-red-400";
      default: return "text-gray-400";
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between">
        <h1>
          <img src="https://www.botangelos.com/assets/img/Botangelos_white.png" alt="Botangelos" className="h-7" />
        </h1>
        <div className="flex items-center gap-4">
          {(session?.user as any)?.role === "admin" && (
            <button
              onClick={() => router.push("/admin")}
              className="px-4 py-2 bg-purple-600 rounded-lg text-sm hover:bg-purple-700"
            >
              Admin Panel
            </button>
          )}
          <span className="text-sm text-gray-400">{session?.user?.name}</span>
          <button
            onClick={() => signOut()}
            className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Problems List */}
      <main className="max-w-4xl mx-auto py-8 px-4">
        <h2 className="text-xl font-semibold mb-6">Available Problems</h2>
        {error && (
          <div className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-4">
            <p className="text-sm text-red-300">{error}</p>
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600"
            >
              Try again
            </button>
          </div>
        )}
        <div className="space-y-3">
          {problems.map((p) => (
            <div
              key={p.id}
              onClick={() => router.push(`/test/${p.slug}`)}
              className="bg-gray-800 p-4 rounded-lg flex items-center justify-between cursor-pointer hover:bg-gray-750 hover:ring-1 hover:ring-green-500 transition-all"
            >
              <div>
                <h3 className="font-medium text-lg">{p.title}</h3>
              </div>
              <span className={`text-sm font-medium capitalize ${difficultyColor(p.difficulty)}`}>
                {p.difficulty}
              </span>
            </div>
          ))}
          {problems.length === 0 && !error && (
            <p className="text-gray-500 text-center py-12">No problems available.</p>
          )}
        </div>
      </main>
    </div>
  );
}
