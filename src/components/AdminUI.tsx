"use client";

// Small pieces every admin screen needs. Kept together so the dashboard, the
// cross-test run list and the proctor log format a duration, a score and a run
// state the same way — an admin comparing two screens should never have to
// work out whether "12:04" on one means the same as "12:04" on the other.

import { useEffect, useState } from "react";

// ── formatting ──────────────────────────────────────────────────────────────

/** Elapsed or remaining time as a clock: m:ss, or h:mm:ss past an hour. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Coarse duration for "idle for" and "x ago" — never more than two units. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function timeAgo(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  const delta = now - t;
  if (delta < 45_000) return "just now";
  return `${shortDuration(delta)} ago`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
}

export function percent(score: number, max: number): number {
  return max > 0 ? Math.round((score / max) * 100) : 0;
}

/** Shared pass/partial/fail colouring, so a 55% is the same yellow everywhere. */
export function scoreColor(pct: number): string {
  return pct >= 60 ? "text-green-400" : pct >= 30 ? "text-yellow-400" : "text-red-400";
}

// ── hooks ───────────────────────────────────────────────────────────────────

/**
 * Re-render on a timer. Countdowns are derived from a fixed `endsAt` rather than
 * decremented, so a tab that was backgrounded comes back showing the right time
 * instead of however far its interval got.
 */
export function useTicker(active: boolean, everyMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
}

// ── pieces ──────────────────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "green" | "yellow" | "red" | "blue" | "purple";
  onClick?: () => void;
}) {
  const color =
    accent === "green"
      ? "text-green-400"
      : accent === "yellow"
      ? "text-yellow-400"
      : accent === "red"
      ? "text-red-400"
      : accent === "blue"
      ? "text-blue-400"
      : accent === "purple"
      ? "text-purple-300"
      : "text-white";

  const body = (
    <>
      <div className={`text-2xl font-semibold leading-none ${color}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1.5">{label}</div>
      {sub && <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>}
    </>
  );

  return onClick ? (
    <button
      onClick={onClick}
      className="text-left bg-gray-800 border border-gray-700 rounded-lg p-3 hover:border-gray-600 transition-colors"
    >
      {body}
    </button>
  ) : (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">{body}</div>
  );
}

export function SessionStateBadge({ state, live }: { state: string; live?: boolean }) {
  const map: Record<string, [string, string]> = {
    in_progress: ["bg-blue-900 text-blue-300", "in progress"],
    submitted: ["bg-green-900 text-green-300", "submitted"],
    auto_submitted: ["bg-yellow-900 text-yellow-300", "time expired"],
    terminated: ["bg-red-900 text-red-300", "terminated"],
  };
  const [cls, label] = map[state] ?? ["bg-gray-700 text-gray-300", state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded whitespace-nowrap ${cls}`}
    >
      {live && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
      {label}
    </span>
  );
}

/** A run with warnings against it, shown against the budget when there is one. */
export function WarningCount({ count, max }: { count: number; max?: number }) {
  if (count === 0) return <span className="text-xs text-gray-600 font-mono">0</span>;
  const atLimit = !!max && max > 0 && count >= max;
  return (
    <span
      className={`text-xs font-mono ${atLimit ? "text-red-400 font-semibold" : "text-yellow-400"}`}
      title={max && max > 0 ? `${count} of ${max} allowed` : `${count} recorded`}
    >
      {count}
      {max && max > 0 ? <span className="text-gray-600">/{max}</span> : null}
    </span>
  );
}

export function Score({ score, max, sub }: { score: number; max: number; sub?: string }) {
  const pct = percent(score, max);
  return (
    <div className="whitespace-nowrap">
      <span className={`font-mono font-semibold ${scoreColor(pct)}`}>{score}</span>
      <span className="text-gray-600 font-mono text-xs">/{max}</span>
      {sub && <div className="text-[10px] text-gray-600">{sub}</div>}
    </div>
  );
}

export function Bar({ value, max, tone = "green" }: { value: number; max: number; tone?: "green" | "blue" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full bg-gray-900 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full ${tone === "blue" ? "bg-blue-500" : "bg-green-500"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-4 pt-4 text-xs text-gray-500">
      <span>
        {total.toLocaleString()} row{total === 1 ? "" : "s"} · page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-gray-800"
        >
          ← Prev
        </button>
        <button
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-gray-800"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

export function Panel({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-gray-800 border border-gray-700 rounded-xl">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-700">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="font-semibold text-sm">{title}</h2>
          {count && <span className="text-xs text-gray-500 truncate">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-gray-500">{children}</p>;
}

export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
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
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };

  return (
    <button
      onClick={copy}
      className="text-xs px-2.5 py-1 bg-gray-700 rounded hover:bg-gray-600 whitespace-nowrap"
    >
      {done ? "Copied!" : label}
    </button>
  );
}
