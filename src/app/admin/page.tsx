"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface AttemptSummary {
  id: string;
  user: { id: string; name: string; email: string; image: string };
  problem: { title: string; slug: string };
  languageId: number;
  state: string;
  score: number;
  maxScore: number;
  createdAt: string;
  finishedAt: string | null;
  runsSummary: { total: number; passed: number; failed: number; pending: number };
}

interface ProctorEvent {
  id: string;
  userId: string;
  attemptId: string | null;
  event: string;
  detail: string | null;
  createdAt: string;
}

interface UserInfo {
  id: string;
  name: string;
  email: string;
  image: string;
  role: string;
  _count: { attempts: number };
}

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<"attempts" | "events" | "users">("attempts");
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [events, setEvents] = useState<ProctorEvent[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (session && (session.user as any)?.role !== "admin") {
      router.push("/problems");
    }
  }, [status, session, router]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") {
      loadData();
    }
  }, [session, tab]);

  const loadData = async () => {
    setLoading(true);
    try {
      if (tab === "attempts") {
        const res = await fetch("/api/admin/attempts");
        const data = await res.json();
        setAttempts(data.attempts);
      } else if (tab === "events") {
        const res = await fetch("/api/admin/proctor-events");
        const data = await res.json();
        setEvents(data.events);
      } else if (tab === "users") {
        const res = await fetch("/api/admin/users");
        const data = await res.json();
        setUsers(data);
      }
    } catch (e) {
      console.error("Failed to load data:", e);
    }
    setLoading(false);
  };

  const toggleAdmin = async (userId: string, currentRole: string) => {
    const newRole = currentRole === "admin" ? "user" : "admin";
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role: newRole }),
    });
    loadData();
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
      </div>
    );
  }

  const LANGUAGE_NAMES: Record<number, string> = {
    50: "C", 54: "C++", 62: "Java", 63: "JS", 71: "Python", 73: "Rust", 74: "TS",
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">
            Code<span className="text-green-500">Test</span>
            <span className="text-sm text-purple-400 ml-2">Admin</span>
          </h1>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/admin/assessments")}
            className="px-4 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700"
          >
            Tests &amp; candidate links
          </button>
          <button
            onClick={() => router.push("/problems")}
            className="px-4 py-2 bg-gray-700 rounded-lg text-sm hover:bg-gray-600"
          >
            ← Back to Problems
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-gray-700 px-6">
        <div className="flex gap-6">
          {(["attempts", "events", "users"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`py-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? "border-green-500 text-green-400"
                  : "border-transparent text-gray-400 hover:text-gray-300"
              }`}
            >
              {t === "attempts" ? "Test Results" : t === "events" ? "Proctor Events" : "Users"}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="p-6">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : tab === "attempts" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">User</th>
                  <th className="pb-3 pr-4">Problem</th>
                  <th className="pb-3 pr-4">Language</th>
                  <th className="pb-3 pr-4">Score</th>
                  <th className="pb-3 pr-4">Tests</th>
                  <th className="pb-3 pr-4">State</th>
                  <th className="pb-3">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        {a.user.image && (
                          <img src={a.user.image} alt="" className="w-6 h-6 rounded-full" />
                        )}
                        <div>
                          <div className="font-medium">{a.user.name}</div>
                          <div className="text-xs text-gray-500">{a.user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 pr-4">{a.problem.title}</td>
                    <td className="py-3 pr-4">{LANGUAGE_NAMES[a.languageId] || a.languageId}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`font-mono ${
                          a.score === a.maxScore ? "text-green-400" : "text-yellow-400"
                        }`}
                      >
                        {a.score}/{a.maxScore}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-xs">
                      <span className="text-green-400">{a.runsSummary.passed}✓</span>{" "}
                      <span className="text-red-400">{a.runsSummary.failed}✗</span>{" "}
                      {a.runsSummary.pending > 0 && (
                        <span className="text-gray-400">{a.runsSummary.pending}⏳</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          a.state === "done"
                            ? "bg-green-900 text-green-300"
                            : a.state === "error"
                            ? "bg-red-900 text-red-300"
                            : "bg-blue-900 text-blue-300"
                        }`}
                      >
                        {a.state}
                      </span>
                    </td>
                    <td className="py-3 text-xs text-gray-400">
                      {new Date(a.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {attempts.length === 0 && (
              <p className="text-center py-12 text-gray-500">No submissions yet.</p>
            )}
          </div>
        ) : tab === "events" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">Time</th>
                  <th className="pb-3 pr-4">User ID</th>
                  <th className="pb-3 pr-4">Event</th>
                  <th className="pb-3 pr-4">Detail</th>
                  <th className="pb-3">Attempt ID</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-3 pr-4 text-xs text-gray-400">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">{e.userId.slice(0, 8)}...</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          e.event === "tab_switch" || e.event === "window_blur"
                            ? "bg-yellow-900 text-yellow-300"
                            : e.event === "copy" || e.event === "paste"
                            ? "bg-red-900 text-red-300"
                            : "bg-orange-900 text-orange-300"
                        }`}
                      >
                        {e.event}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-xs text-gray-400">{e.detail || "—"}</td>
                    <td className="py-3 font-mono text-xs text-gray-500">
                      {e.attemptId ? `${e.attemptId.slice(0, 8)}...` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length === 0 && (
              <p className="text-center py-12 text-gray-500">No proctor events recorded.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="pb-3 pr-4">User</th>
                  <th className="pb-3 pr-4">Email</th>
                  <th className="pb-3 pr-4">Role</th>
                  <th className="pb-3 pr-4">Attempts</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        {u.image && <img src={u.image} alt="" className="w-6 h-6 rounded-full" />}
                        <span>{u.name || "—"}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-gray-400">{u.email}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          u.role === "admin" ? "bg-purple-900 text-purple-300" : "bg-gray-700 text-gray-300"
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="py-3 pr-4">{u._count.attempts}</td>
                    <td className="py-3">
                      <button
                        onClick={() => toggleAdmin(u.id, u.role)}
                        className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600"
                      >
                        {u.role === "admin" ? "Remove Admin" : "Make Admin"}
                      </button>
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
