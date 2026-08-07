"use client";

// Accounts, and what each one can do.
//
// Anyone who signs in with Google gets an account, so most rows here are
// candidates rather than staff — the role toggle is the only lever, and the
// activity columns are what tell the two apart at a glance.

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Empty, Panel, dateTime, timeAgo } from "@/components/AdminUI";
import { errorMessage, fetchJson, HttpError, postJson } from "@/lib/fetch-json";

interface Row {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: string;
  lastSeenAt: string | null;
  _count: { attempts: number; testSessions: number };
}

export default function AdminUsersPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const myId = (session?.user as any)?.id as string | undefined;

  const [users, setUsers] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const handleError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.replace(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, fallback));
    },
    [router]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<Row[]>("/api/admin/users");
      setUsers(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      handleError(err, "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleAdmin = async (u: Row) => {
    const next = u.role === "admin" ? "user" : "admin";
    // Dropping your own admin locks you out of every page in this section, and
    // there is no UI anywhere to grant it back.
    if (u.id === myId && next === "user") {
      const ok = confirm(
        "Remove your own admin access?\n\nYou will lose the admin panel immediately, and only " +
          "another admin — or a direct database change — can give it back."
      );
      if (!ok) return;
    }

    setBusyId(u.id);
    try {
      await postJson("/api/admin/users", { userId: u.id, role: next }, { method: "PATCH" });
    } catch (err) {
      handleError(err, "Could not change that user's role.");
      return;
    } finally {
      setBusyId(null);
    }
    load();
  };

  const needle = q.trim().toLowerCase();
  const visible = needle
    ? users.filter(
        (u) =>
          (u.name ?? "").toLowerCase().includes(needle) ||
          (u.email ?? "").toLowerCase().includes(needle)
      )
    : users;

  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <div>
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 bg-gray-900 z-10">
        <div>
          <h1 className="text-xl font-bold">Users</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {users.length} account{users.length === 1 ? "" : "s"} · {adminCount} admin
            {adminCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or email…"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-64"
          />
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-700 rounded text-xs hover:bg-gray-600 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      <main className="p-6 space-y-4">
        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        <Panel title="Accounts" count={needle ? `${visible.length} matching` : undefined}>
          {loading && users.length === 0 ? (
            <Empty>Loading…</Empty>
          ) : visible.length === 0 ? (
            <Empty>{needle ? "No accounts match that search." : "No accounts yet."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-700 text-xs">
                    <th className="py-2 pl-4 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium text-right">Tests taken</th>
                    <th className="py-2 pr-3 font-medium text-right">Submissions</th>
                    <th className="py-2 pr-3 font-medium">Last seen in a test</th>
                    <th className="py-2 pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-gray-700/60 last:border-0 hover:bg-gray-900/40"
                    >
                      <td className="py-2.5 pl-4 pr-3">
                        <div className="flex items-center gap-2">
                          {u.image && (
                            <img src={u.image} alt="" className="w-6 h-6 rounded-full shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[16rem]">
                              {u.name || "—"}
                              {u.id === myId && (
                                <span className="ml-2 text-[11px] text-gray-500">you</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 truncate max-w-[16rem]">
                              {u.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            u.role === "admin"
                              ? "bg-purple-900 text-purple-300"
                              : "bg-gray-700 text-gray-300"
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        {u._count.testSessions || <span className="text-gray-600">0</span>}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-xs">
                        {u._count.attempts || <span className="text-gray-600">0</span>}
                      </td>
                      <td
                        className="py-2.5 pr-3 text-xs text-gray-500"
                        title={dateTime(u.lastSeenAt)}
                      >
                        {u.lastSeenAt ? timeAgo(u.lastSeenAt) : "never"}
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        <button
                          onClick={() => toggleAdmin(u)}
                          disabled={busyId === u.id}
                          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-40 whitespace-nowrap"
                        >
                          {busyId === u.id
                            ? "Saving…"
                            : u.role === "admin"
                            ? "Remove admin"
                            : "Make admin"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
