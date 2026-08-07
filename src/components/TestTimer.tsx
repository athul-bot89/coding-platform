"use client";

import { useEffect, useState } from "react";

interface Props {
  /** Absolute client-clock deadline, derived from the server's remainingMs. */
  deadline: number;
  onExpire: () => void;
}

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Displays the countdown. Purely cosmetic — `deadline` is recomputed from the
 * server's `remainingMs` on every heartbeat, and every endpoint independently
 * rejects work that arrives after the real deadline.
 */
export function TestTimer({ deadline, onExpire }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));
  const [fired, setFired] = useState(false);

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);

  useEffect(() => {
    if (remaining <= 0 && !fired) {
      setFired(true);
      onExpire();
    }
  }, [remaining, fired, onExpire]);

  const critical = remaining <= 60_000;
  const warning = remaining <= 5 * 60_000;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-lg tabular-nums transition-colors ${
        critical
          ? "bg-red-600 text-white animate-pulse"
          : warning
          ? "bg-yellow-600/20 text-yellow-300 border border-yellow-700"
          : "bg-gray-800 text-gray-200 border border-gray-700"
      }`}
      title="Time remaining"
    >
      <span className="text-sm">⏱</span>
      {format(remaining)}
    </div>
  );
}
