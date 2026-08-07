"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { fetchJson, postJson, errorMessage, HttpError } from "@/lib/fetch-json";
import { DEFAULT_MAX_VIOLATIONS } from "@/lib/proctor-config";

interface Detail {
  id: string;
  title: string;
  instructions: string | null;
  durationMinutes: number;
  maxViolations: number;
  isActive: boolean;
  joinUrl: string;
  problems: { problemId: string; ordinal: number; points: number; title: string; difficulty: string }[];
  availableProblems: { id: string; title: string; slug: string; difficulty: string }[];
  startedCount: number;
  inProgressCount: number;
  completedCount: number;
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
    maxViolations: DEFAULT_MAX_VIOLATIONS,
    instructions: "",
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (session && (session.user as any)?.role !== "admin") router.push("/problems");
  }, [status, session, router]);

  // The admin role cached in the session cookie can outlive the server's view of
  // it, so a 401 or 403 from any call here means this browser is no longer an
  // admin — leave, rather than showing a permission error it cannot act on.
  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        router.push(err.status === 401 ? "/" : "/problems");
        return;
      }
      setError(errorMessage(err, fallback));
    },
    [router]
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await fetchJson<Detail>(`/api/admin/assessments/${id}`);
      // Everything below maps over these three lists, so a truncated response
      // should leave a section empty rather than take the whole page down.
      const problems = Array.isArray(body.problems) ? body.problems : [];
      setData({
        ...body,
        problems,
        availableProblems: Array.isArray(body.availableProblems) ? body.availableProblems : [],
      });
      setPicked(problems.map((p) => ({ problemId: p.problemId, points: p.points })));
      setSettings({
        title: body.title,
        durationMinutes: body.durationMinutes,
        maxViolations: body.maxViolations,
        instructions: body.instructions ?? "",
      });
    } catch (err) {
      reportError(err, "Could not load this test.");
    }
  }, [id, reportError]);

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
    try {
      await postJson(
        `/api/admin/assessments/${id}`,
        { ...settings, problems: picked },
        { method: "PATCH" }
      );
    } catch (err) {
      reportError(err, "Save failed.");
      return;
    } finally {
      setSaving(false);
    }
    flash("Saved");
    load();
  };

  const setActive = async (isActive: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/admin/assessments/${id}`, { isActive }, { method: "PATCH" });
    } catch (err) {
      reportError(err, isActive ? "Could not open the test." : "Could not close the test.");
      return;
    } finally {
      setSaving(false);
    }
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

  const rotateLink = async () => {
    if (
      !confirm(
        "Issue a new link?\n\nEvery copy of the current link stops working immediately. Candidates already taking the test are unaffected."
      )
    ) {
      return;
    }
    setRotating(true);
    setError(null);
    try {
      await postJson(`/api/admin/assessments/${id}/link`, {});
    } catch (err) {
      reportError(err, "Could not issue a new link.");
      return;
    } finally {
      setRotating(false);
    }
    flash("New link issued");
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
            onClick={() => router.push(`/admin/assessments/${id}/leaderboard`)}
            className="px-4 py-2 bg-purple-900/60 rounded-lg text-sm font-medium hover:bg-purple-900"
          >
            🏆 Leaderboard
            {data.startedCount > 0 && (
              <span className="ml-2 text-xs text-purple-300">{data.startedCount}</span>
            )}
          </button>
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
                onClick={() => setActive(!data.isActive)}
                disabled={saving}
                className={`w-full px-3 py-2 rounded text-sm disabled:opacity-50 ${
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
              Each session takes its own copy of this list — questions, order and point values — at
              the moment the candidate starts. Anyone testing right now finishes on the exact
              questions and points they were served, so nothing they have already earned can move.
              These edits apply to sessions started after you save.
            </p>
          </div>
        </section>

        {/* Shared link */}
        <section className="bg-gray-800 border border-gray-700 rounded-xl p-5">
          <h2 className="font-semibold mb-1">Test link</h2>
          <p className="text-xs text-gray-500 mb-4">
            One link for everyone. Send it however you like — nothing is emailed from here. Anyone
            who opens it signs in with Google and gets a single attempt; the account they use is
            the name that appears on the leaderboard.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-[16rem] bg-gray-900 border border-gray-700 rounded px-3 py-2.5 text-sm text-green-400 break-all">
              {data.joinUrl}
            </code>
            <button
              onClick={() => copy(data.joinUrl, "join")}
              className="px-4 py-2.5 bg-green-600 rounded text-sm font-medium hover:bg-green-700"
            >
              {copied === "join" ? "Copied!" : "Copy link"}
            </button>
            <button
              onClick={rotateLink}
              disabled={rotating}
              className="px-3 py-2.5 bg-gray-700 rounded text-sm hover:bg-gray-600 disabled:opacity-50"
              title="Issue a new link and kill the current one"
            >
              {rotating ? "Working…" : "New link"}
            </button>
          </div>

          {picked.length === 0 && (
            <p className="text-xs text-yellow-400 mt-3">
              This link will not open until you add and save at least one question.
            </p>
          )}
          {!data.isActive && picked.length > 0 && (
            <p className="text-xs text-yellow-400 mt-3">
              The test is closed, so this link turns anyone new away. Open it in Settings above when
              you are ready.
            </p>
          )}

          <p className="text-xs text-gray-600 mt-3">
            The link is unguessable, but it is not tied to anyone — whoever holds it can take the
            test. <strong>New link</strong> invalidates every copy of the current one at once, and
            leaves candidates already working untouched.
          </p>

          <div className="grid grid-cols-3 gap-3 mt-5">
            {[
              ["Started", data.startedCount],
              ["In progress", data.inProgressCount],
              ["Completed", data.completedCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="bg-gray-900 rounded-lg p-3 text-center">
                <div className="text-lg font-semibold">{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          <button
            onClick={() => router.push(`/admin/assessments/${id}/leaderboard`)}
            className="w-full mt-3 px-4 py-2 bg-gray-700 rounded text-sm hover:bg-gray-600"
          >
            View leaderboard and reports →
          </button>
        </section>
      </main>
    </div>
  );
}
