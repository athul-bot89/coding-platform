"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface Detail {
  id: string;
  title: string;
  instructions: string | null;
  durationMinutes: number;
  maxViolations: number;
  isActive: boolean;
  problems: { problemId: string; ordinal: number; points: number; title: string; difficulty: string }[];
  availableProblems: { id: string; title: string; slug: string; difficulty: string }[];
  invitations: {
    id: string;
    candidateName: string;
    candidateEmail: string;
    status: string;
    expiresAt: string;
    url: string;
    sessionId: string | null;
    sessionState: string | null;
    score: number | null;
    maxScore: number | null;
    violationCount: number | null;
  }[];
}

export default function AssessmentDetailPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const id = useParams().id as string;

  const [data, setData] = useState<Detail | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ problemId: string; points: number }[]>([]);
  const [settings, setSettings] = useState({
    title: "",
    durationMinutes: 90,
    maxViolations: 3,
    instructions: "",
  });
  const [candidateText, setCandidateText] = useState("");
  const [validDays, setValidDays] = useState(7);
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/assessments/${id}`);
    if (!res.ok) {
      setError("Could not load this test.");
      return;
    }
    const body: Detail = await res.json();
    setData(body);
    setPicked(body.problems.map((p) => ({ problemId: p.problemId, points: p.points })));
    setSettings({
      title: body.title,
      durationMinutes: body.durationMinutes,
      maxViolations: body.maxViolations,
      instructions: body.instructions ?? "",
    });
  }, [id]);

  useEffect(() => {
    if (session && (session.user as any)?.role === "admin") load();
  }, [session, load]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/admin/assessments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, problems: picked }),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(body.error || "Save failed.");
      return;
    }
    flash("Saved");
    load();
  };

  const toggleProblem = (problemId: string) => {
    setPicked((prev) =>
      prev.some((p) => p.problemId === problemId)
        ? prev.filter((p) => p.problemId !== problemId)
        : [...prev, { problemId, points: 100 }]
    );
  };

  const move = (index: number, delta: number) => {
    setPicked((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const generate = async () => {
    setInviting(true);
    setError(null);

    // One candidate per line: "Name <email>", "Name, email", or just an email.
    const candidates = candidateText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const angled = line.match(/^(.*?)\s*<([^>]+)>$/);
        if (angled) return { name: angled[1].trim(), email: angled[2].trim() };
        const parts = line.split(/[,;\t]/).map((s) => s.trim());
        if (parts.length >= 2) return { name: parts[0], email: parts[1] };
        return { name: "", email: line };
      });

    if (candidates.length === 0) {
      setError("Add at least one candidate.");
      setInviting(false);
      return;
    }

    const res = await fetch(`/api/admin/assessments/${id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates, validDays }),
    });
    const body = await res.json().catch(() => ({}));
    setInviting(false);

    if (!res.ok) {
      setError(body.error || "Could not generate links.");
      return;
    }
    setCandidateText("");
    flash(`${body.invitations.length} link(s) generated`);
    load();
  };

  const revoke = async (invitationId: string) => {
    const res = await fetch(
      `/api/admin/assessments/${id}/invitations?invitationId=${invitationId}`,
      { method: "DELETE" }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Could not revoke.");
      return;
    }
    load();
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to a temp textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
  };

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        {error ? <p className="text-red-400">{error}</p> : <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500" />}
      </div>
    );
  }

  const byId = new Map(data.availableProblems.map((p) => [p.id, p]));
  const totalPoints = picked.reduce((s, p) => s + p.points, 0);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-700 px-6 py-4 flex items-center justify-between sticky top-0 bg-gray-900 z-10">
        <div className="min-w-0">
          <button
            onClick={() => router.push("/admin/assessments")}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            ← All tests
          </button>
          <h1 className="text-xl font-bold truncate">{data.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          {notice && <span className="text-sm text-green-400">{notice}</span>}
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 bg-green-600 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </header>

      <main className="p-6 max-w-5xl space-y-6">
        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        {/* Settings */}
        <section className="bg-gray-800 border border-gray-700 rounded-xl p-5">
          <h2 className="font-semibold mb-4">Settings</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="md:col-span-3 block">
              <span className="text-xs text-gray-400 block mb-1">Title</span>
              <input
                value={settings.title}
                onChange={(e) => setSettings({ ...settings, title: e.target.value })}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 block mb-1">Duration (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={settings.durationMinutes}
                onChange={(e) =>
                  setSettings({ ...settings, durationMinutes: Number(e.target.value) })
                }
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
                value={settings.maxViolations}
                onChange={(e) =>
                  setSettings({ ...settings, maxViolations: Number(e.target.value) })
                }
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 block mb-1">Status</span>
              <button
                onClick={async () => {
                  await fetch(`/api/admin/assessments/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ isActive: !data.isActive }),
                  });
                  load();
                }}
                className={`w-full px-3 py-2 rounded text-sm ${
                  data.isActive ? "bg-green-900 text-green-300" : "bg-gray-700 text-gray-300"
                }`}
              >
                {data.isActive ? "Open — click to close" : "Closed — click to open"}
              </button>
            </label>
            <label className="md:col-span-3 block">
              <span className="text-xs text-gray-400 block mb-1">
                Instructions shown before starting (markdown)
              </span>
              <textarea
                rows={3}
                value={settings.instructions}
                onChange={(e) => setSettings({ ...settings, instructions: e.target.value })}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
          </div>
        </section>

        {/* Questions */}
        <section className="bg-gray-800 border border-gray-700 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Questions</h2>
            <span className="text-xs text-gray-500">
              {picked.length} selected · {totalPoints} points total
            </span>
          </div>

          {picked.length > 0 && (
            <div className="space-y-2 mb-5">
              {picked.map((p, i) => {
                const info = byId.get(p.problemId);
                return (
                  <div
                    key={p.problemId}
                    className="flex items-center gap-3 bg-gray-900 rounded px-3 py-2"
                  >
                    <span className="text-xs text-gray-500 w-7">Q{i + 1}</span>
                    <span className="flex-1 text-sm truncate">
                      {info?.title ??
                        data.problems.find((dp) => dp.problemId === p.problemId)?.title ??
                        "Unknown problem"}
                    </span>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        value={p.points}
                        onChange={(e) =>
                          setPicked((prev) =>
                            prev.map((x) =>
                              x.problemId === p.problemId
                                ? { ...x, points: Number(e.target.value) }
                                : x
                            )
                          )
                        }
                        className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-right"
                      />
                      <span className="text-xs text-gray-500">pts</span>
                    </label>
                    <div className="flex gap-1">
                      <button
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        className="px-2 py-1 bg-gray-800 rounded text-xs disabled:opacity-30 hover:bg-gray-700"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => move(i, 1)}
                        disabled={i === picked.length - 1}
                        className="px-2 py-1 bg-gray-800 rounded text-xs disabled:opacity-30 hover:bg-gray-700"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => toggleProblem(p.problemId)}
                        className="px-2 py-1 bg-red-900/60 rounded text-xs hover:bg-red-900"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="border-t border-gray-700 pt-4">
            <p className="text-xs text-gray-400 mb-2">Add a problem</p>
            <div className="flex flex-wrap gap-2">
              {data.availableProblems
                .filter((p) => !picked.some((x) => x.problemId === p.id))
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => toggleProblem(p.id)}
                    className="px-3 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs hover:border-green-600"
                  >
                    + {p.title}
                    <span
                      className={`ml-2 ${
                        p.difficulty === "easy"
                          ? "text-green-400"
                          : p.difficulty === "hard"
                          ? "text-red-400"
                          : "text-yellow-400"
                      }`}
                    >
                      {p.difficulty}
                    </span>
                  </button>
                ))}
            </div>
            <p className="text-xs text-gray-600 mt-3">
              Changing questions affects tests started from now on. Candidates already in progress
              keep the questions they were served.
            </p>
          </div>
        </section>

        {/* Invitations */}
        <section className="bg-gray-800 border border-gray-700 rounded-xl p-5">
          <h2 className="font-semibold mb-1">Candidate links</h2>
          <p className="text-xs text-gray-500 mb-4">
            Each link works once, for one Google account. Copy it into your own email — nothing is
            sent from here.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
            <label className="md:col-span-3 block">
              <span className="text-xs text-gray-400 block mb-1">
                One candidate per line — <code className="text-gray-500">Name &lt;email&gt;</code>,{" "}
                <code className="text-gray-500">Name, email</code>, or just an email
              </span>
              <textarea
                rows={3}
                value={candidateText}
                onChange={(e) => setCandidateText(e.target.value)}
                placeholder={"Asha Menon <asha@example.com>\nrahul@example.com"}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 block mb-1">Link valid (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={validDays}
                onChange={(e) => setValidDays(Number(e.target.value))}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              />
              <button
                onClick={generate}
                disabled={inviting || picked.length === 0}
                className="w-full mt-2 px-4 py-2 bg-green-600 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-40"
              >
                {inviting ? "Generating…" : "Generate links"}
              </button>
            </label>
          </div>

          {picked.length === 0 && (
            <p className="text-xs text-yellow-400 mb-4">
              Add and save at least one question before generating links.
            </p>
          )}

          {data.invitations.length > 0 && (
            <>
              <div className="flex justify-end mb-2">
                <button
                  onClick={() =>
                    copy(
                      data.invitations
                        .filter((i) => i.status === "pending")
                        .map((i) => `${i.candidateName} <${i.candidateEmail}>: ${i.url}`)
                        .join("\n"),
                      "all"
                    )
                  }
                  className="text-xs px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600"
                >
                  {copied === "all" ? "Copied!" : "Copy all unused links"}
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="pb-2 pr-3">Candidate</th>
                      <th className="pb-2 pr-3">Status</th>
                      <th className="pb-2 pr-3">Score</th>
                      <th className="pb-2 pr-3">Warnings</th>
                      <th className="pb-2">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invitations.map((inv) => (
                      <tr key={inv.id} className="border-b border-gray-800">
                        <td className="py-2.5 pr-3">
                          <div>{inv.candidateName}</div>
                          <div className="text-xs text-gray-500">{inv.candidateEmail}</div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <StatusBadge status={inv.sessionState ?? inv.status} />
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs">
                          {inv.score != null ? `${inv.score}/${inv.maxScore}` : "—"}
                        </td>
                        <td className="py-2.5 pr-3 text-xs">
                          {inv.violationCount != null ? (
                            <span className={inv.violationCount > 0 ? "text-red-400" : "text-gray-500"}>
                              {inv.violationCount}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2">
                            {inv.sessionId ? (
                              <button
                                onClick={() => router.push(`/admin/sessions/${inv.sessionId}`)}
                                className="text-xs px-3 py-1 bg-purple-900/60 rounded hover:bg-purple-900"
                              >
                                View report
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => copy(inv.url, inv.id)}
                                  className="text-xs px-3 py-1 bg-gray-700 rounded hover:bg-gray-600"
                                >
                                  {copied === inv.id ? "Copied!" : "Copy link"}
                                </button>
                                <button
                                  onClick={() => revoke(inv.id)}
                                  className="text-xs px-2 py-1 text-gray-500 hover:text-red-400"
                                >
                                  Revoke
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-700 text-gray-300",
    started: "bg-blue-900 text-blue-300",
    in_progress: "bg-blue-900 text-blue-300",
    submitted: "bg-green-900 text-green-300",
    auto_submitted: "bg-yellow-900 text-yellow-300",
    terminated: "bg-red-900 text-red-300",
    expired: "bg-gray-800 text-gray-500",
  };
  const labels: Record<string, string> = {
    pending: "not started",
    started: "in progress",
    in_progress: "in progress",
    submitted: "submitted",
    auto_submitted: "time expired",
    terminated: "terminated",
    expired: "link expired",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[status] ?? styles.pending}`}>
      {labels[status] ?? status}
    </span>
  );
}
