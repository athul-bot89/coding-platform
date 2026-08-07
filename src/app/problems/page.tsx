"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  useEffect(() => {
    if (session) {
      fetch("/api/problems")
        .then((r) => r.json())
        .then((data) => {
          setProblems(data);
          setLoading(false);
        });
    }
  }, [session]);

  if (status === "loading" || loading) {
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
        <h1 className="text-2xl font-bold">
          Code<span className="text-green-500">Test</span>
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
          {problems.length === 0 && (
            <p className="text-gray-500 text-center py-12">No problems available.</p>
          )}
        </div>
      </main>
    </div>
  );
}
