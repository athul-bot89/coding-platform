// Proctoring policy. Everything tunable lives here so the strictness of a test
// can be adjusted without touching detection or enforcement code.

/** Events that increment TestSession.violationCount and can auto-submit a test. */
export const COUNTED_EVENTS = ["fullscreen_exit", "tab_switch", "window_blur", "multi_display"] as const;

/**
 * Events that are blocked and recorded but never burn a warning.
 * Ctrl+V is muscle memory — the attempt is still surfaced on the report, but a
 * candidate shouldn't lose their test over a reflex that was blocked anyway.
 * Move "paste" into COUNTED_EVENTS to make clipboard attempts fatal.
 */
export const LOGGED_ONLY = [
  "copy",
  "paste",
  "cut",
  "right_click",
  "devtools",
  "drop",
  "print",
] as const;

/**
 * Recorded for the report but never shown to the candidate as a blocked action —
 * these describe the connection, not something they did. They are also the only
 * events allowed to be backdated, since they are reported once the connection is
 * back rather than when they happened.
 */
export const SILENT_EVENTS = ["connection_lost", "connection_restored"] as const;

export const VALID_EVENTS: string[] = [...COUNTED_EVENTS, ...LOGGED_ONLY, ...SILENT_EVENTS];

export function isSilentEvent(event: string): boolean {
  return (SILENT_EVENTS as readonly string[]).includes(event);
}

/**
 * Counted violations a candidate gets before the test is auto-submitted —
 * the HackerRank default. The Nth violation is the one that ends the test, so
 * this is a budget of 5 warnings, not 5 warnings plus a sixth strike.
 *
 * Only the seed and the admin forms read this; the enforced value is the
 * per-assessment `Assessment.maxViolations` column (0 disables auto-submit),
 * whose database default is kept in sync in prisma/schema.prisma.
 */
export const DEFAULT_MAX_VIOLATIONS = 5;

export function isCountedEvent(event: string): boolean {
  return (COUNTED_EVENTS as readonly string[]).includes(event);
}

/**
 * `detail` is free-form text from the browser, so it is bounded before storage —
 * long enough to explain what happened, short enough that a hostile client
 * cannot grow the event log a megabyte at a time.
 */
export const EVENT_DETAIL_MAX = 500;

export function truncateEventDetail(detail: unknown): string | null {
  if (typeof detail !== "string" || detail === "") return null;
  return detail.slice(0, EVENT_DETAIL_MAX);
}

/**
 * Alt-tabbing fires `blur` and `visibilitychange` back to back. Without this
 * window a single switch would burn two warnings.
 */
export const DEDUPE_MS = 1200;

/** A single insertion larger than this is paste-shaped, not typed. */
export const BURST_CHARS = 40;

/** Heartbeat cadence — also how often the client re-syncs the clock. */
export const HEARTBEAT_MS = 10_000;

/**
 * How long a live session stays "online" on the admin monitor after its last
 * heartbeat. Three missed beats — wide enough to ride out one slow request
 * without the row flickering, tight enough that a closed laptop shows up fast.
 */
export const ONLINE_GRACE_MS = HEARTBEAT_MS * 3;

/** Debounce before an edited draft is persisted, and the retry cadence after that. */
export const DRAFT_SAVE_MS = 2_000;

// ---------------------------------------------------------------------------
// Losing the connection
//
// A candidate cannot be made to pay for their network. Code is mirrored on their
// own machine and re-sent until it lands, and the time an outage ate is given
// back to their clock — bounded, because pulling the network is otherwise the
// cheapest way to buy thinking time.
// ---------------------------------------------------------------------------

/**
 * A gap between heartbeats shorter than this is jitter or one slow request, not
 * an outage. Two missed beats is the floor for crediting time back.
 */
export const OFFLINE_CREDIT_MIN_MS = HEARTBEAT_MS * 2;

/**
 * The most time one session can ever be credited, however many outages it takes.
 * Spent across the whole test and surfaced on the report, so a candidate who
 * "loses connection" for nine minutes is visible to whoever reviews them.
 */
export const MAX_OFFLINE_CREDIT_MS = 10 * 60_000;

/** How often the client retries while it believes it is offline. */
export const OFFLINE_PROBE_MS = 3_000;

/** Tries for a request that must not be dropped, and the gap between them. */
export const FINISH_ATTEMPTS = 3;
export const FINISH_RETRY_MS = 1_200;

/**
 * How long the grading poll keeps waiting through an outage before it stops and
 * tells the candidate their submission will be scored without them watching.
 */
export const POLL_OFFLINE_BUDGET_MS = 5 * 60_000;

/** How often buffered typing metrics are flushed. */
export const METRICS_FLUSH_MS = 15_000;

/**
 * What a candidate is told when a LOGGED_ONLY action is blocked. These are
 * statements of fact, not warnings: the action did not happen and nothing was
 * held against them, so the copy must not imply a strike. Anything missing here
 * falls back to BLOCKED_FALLBACK.
 */
export const BLOCKED_MESSAGES: Record<string, string> = {
  copy: "Copy and paste are disabled in this test.",
  cut: "Copy and paste are disabled in this test.",
  paste: "Copy and paste are disabled in this test.",
  right_click: "Right-click is disabled in this test.",
  devtools: "Developer tools are disabled in this test.",
  print: "Printing is disabled in this test.",
  drop: "Dragging text into the editor is disabled in this test.",
  // Not a blocked action but a passive detection, so it gets its own wording
  // rather than the "disabled" fallback.
  multi_display: "Multiple displays detected — please use a single screen.",
};

export const BLOCKED_FALLBACK = "That action is disabled in this test.";

// ---------------------------------------------------------------------------
// Telling a candidate about a counted violation
//
// The running tally is never shown during a test. A visible "2/5" turns the
// budget into a resource to spend: a candidate who knows three are left will
// use them. Withholding the number keeps every violation feeling like it might
// be the last one, which is the behaviour the budget exists to produce.
//
// What replaces it is tone, not silence. Every counted violation still says so
// plainly, and the wording hardens as the limit approaches, so nobody is
// auto-submitted without having been told they were close first.
//
// `maxViolations` is still sent to the browser — this is UI-level concealment,
// not a secret. Anyone who reads the network response can recover the count,
// and the pre-test instructions state the limit up front.
// ---------------------------------------------------------------------------

export type ViolationLevel = "none" | "logged" | "noted" | "close" | "final";

/**
 * How loudly to warn, given the tally the candidate is not allowed to see.
 *
 * `max <= 0` is auto-submit disabled for the whole assessment: the violation is
 * still recorded for the report, but there is no limit to be close to, so the
 * copy must not threaten a submission that cannot happen — hence "logged"
 * rather than the escalating ladder.
 */
export function violationLevel(count: number, max: number): ViolationLevel {
  if (count <= 0) return "none";
  if (max <= 0) return "logged";
  const remaining = max - count;
  if (remaining <= 1) return "final";
  if (remaining <= 2) return "close";
  return "noted";
}

type WarnLevel = Exclude<ViolationLevel, "none">;

/** Toast shown when a violation is counted. Deliberately free of digits. */
export const VIOLATION_MESSAGES: Record<WarnLevel, string> = {
  logged: "This action was recorded.",
  noted: "Violation recorded. Repeated violations will submit your test automatically.",
  close: "Violation recorded — you are close to having your test submitted automatically.",
  final: "Final warning — the next violation will submit your test automatically.",
};

/** Persistent header chip. Short enough to sit next to the clock. */
export const VIOLATION_BADGES: Record<WarnLevel, string> = {
  logged: "Violation recorded",
  noted: "Violation recorded",
  close: "Close to the limit",
  final: "Final warning",
};

/** Fullscreen/overlay copy — same escalation, room for a full sentence. */
export const VIOLATION_OVERLAY: Record<WarnLevel, string> = {
  logged: "This was recorded as a violation.",
  noted: "This was recorded as a violation. Repeated violations will submit your test automatically.",
  close: "This was recorded as a violation. You are close to having your test submitted automatically.",
  final: "Final warning — the next violation will submit your test automatically.",
};

export const EVENT_LABELS: Record<string, string> = {
  fullscreen_exit: "Left fullscreen",
  tab_switch: "Switched tab",
  window_blur: "Left window",
  copy: "Copy blocked",
  paste: "Paste blocked",
  cut: "Cut blocked",
  right_click: "Right-click blocked",
  devtools: "DevTools shortcut",
  drop: "Drag-drop blocked",
  print: "Print blocked",
  multi_display: "Multiple displays detected",
  connection_lost: "Connection lost",
  connection_restored: "Reconnected",
};
