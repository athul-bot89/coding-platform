"use client";

import { MAX_OFFLINE_CREDIT_MS } from "@/lib/proctor-config";

interface Props {
  /** False once a request has failed at the network level, until one succeeds. */
  online: boolean;
  /** When the connection dropped, for showing how long it has been down. */
  offlineSince: number | null;
  /** Now, ticked by the parent, so the outage duration counts up. */
  now: number;
  /** Problems whose latest code has not reached the server yet. */
  unsyncedCount: number;
  /** Submissions waiting to be sent the moment the connection is back. */
  queuedCount: number;
  /** Total time already added back to this session's clock. */
  creditedMs: number;
  /** Set briefly after a reconnect that recovered time; cleared by the parent. */
  justCreditedMs: number | null;
  /** The countdown reached zero while offline — the server has not confirmed yet. */
  awaitingServer: boolean;
  /** The browser refused to mirror code locally, so the editor is the only copy. */
  localSaveFailed: boolean;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * What the candidate is told about their connection.
 *
 * The copy carries one message: nothing you have done is lost, and the time this
 * costs you is coming back. A candidate who believes an outage has cost them the
 * test stops working, which is the actual damage a dropped connection does.
 */
export function ConnectionBanner({
  online,
  offlineSince,
  now,
  unsyncedCount,
  queuedCount,
  creditedMs,
  justCreditedMs,
  awaitingServer,
  localSaveFailed,
}: Props) {
  if (!online) {
    const downMs = offlineSince ? now - offlineSince : 0;
    const creditLeft = Math.max(0, MAX_OFFLINE_CREDIT_MS - creditedMs);

    return (
      <Bar tone="warning">
        <span className="w-2 h-2 rounded-full bg-yellow-300 animate-pulse shrink-0" />
        <span>
          <strong>Connection lost{downMs > 3000 ? ` — ${formatDuration(downMs)}` : ""}.</strong>{" "}
          Keep working. Your code is saved on this device and is sent automatically when you
          reconnect
          {queuedCount > 0 &&
            `, along with ${queuedCount} submission${queuedCount === 1 ? "" : "s"} waiting to go`}
          .{" "}
          {creditLeft > 0 ? (
            <>Time lost to this outage is added back to your clock (up to {formatDuration(creditLeft)} left).</>
          ) : (
            <>Your extra-time allowance for this test is used up, so the clock keeps running.</>
          )}
        </span>
      </Bar>
    );
  }

  if (awaitingServer) {
    return (
      <Bar tone="warning">
        <span className="w-2 h-2 rounded-full bg-yellow-300 animate-pulse shrink-0" />
        <span>
          Your time is up. Confirming with the server and saving everything before the test closes…
        </span>
      </Bar>
    );
  }

  if (justCreditedMs && justCreditedMs > 0) {
    return (
      <Bar tone="good">
        <span className="shrink-0">✓</span>
        <span>
          <strong>Back online.</strong> {formatDuration(justCreditedMs)} of lost time was added back
          to your clock
          {unsyncedCount > 0 ? " and your code is being saved" : " and all your code is saved"}.
        </span>
      </Bar>
    );
  }

  if (localSaveFailed) {
    return (
      <Bar tone="warning">
        <span className="shrink-0">⚠</span>
        <span>
          This browser will not let the test keep a local copy of your code — private browsing, or
          storage that is full. Your work still saves to the server every few seconds; avoid closing
          this tab.
        </span>
      </Bar>
    );
  }

  return null;
}

function Bar({ tone, children }: { tone: "warning" | "good"; children: React.ReactNode }) {
  const styles =
    tone === "good"
      ? "bg-green-950/80 border-green-800 text-green-200"
      : "bg-yellow-950/80 border-yellow-800 text-yellow-100";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 px-4 py-2 text-xs border-b shrink-0 ${styles}`}
    >
      {children}
    </div>
  );
}

/**
 * The header's save indicator. Small on purpose: it is reassurance, and a
 * candidate should not be reading it instead of solving the question.
 *
 * States, not timestamps. "Saved 40 seconds ago" would need a ticking clock for
 * the length of the test, and it invites a candidate to worry about a number that
 * means nothing — either the code is on the server or the flusher is still working
 * on it.
 */
export function SaveState({
  online,
  unsyncedCount,
  hasSaved,
}: {
  online: boolean;
  unsyncedCount: number;
  /** Whether anything has been successfully saved yet this session. */
  hasSaved: boolean;
}) {
  if (!online) {
    return (
      <span
        className="text-[11px] text-yellow-300 whitespace-nowrap"
        title="Your code is saved on this device and will be sent when you reconnect"
      >
        ⚠ saved on this device
      </span>
    );
  }
  if (unsyncedCount > 0) {
    return <span className="text-[11px] text-gray-400 whitespace-nowrap">saving…</span>;
  }
  if (!hasSaved) return null;
  return (
    <span className="text-[11px] text-gray-500 whitespace-nowrap" title="Your code is on the server">
      ✓ saved
    </span>
  );
}
