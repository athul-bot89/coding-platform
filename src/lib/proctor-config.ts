// Proctoring policy. Everything tunable lives here so the strictness of a test
// can be adjusted without touching detection or enforcement code.

/** Events that increment TestSession.violationCount and can auto-submit a test. */
export const COUNTED_EVENTS = ["fullscreen_exit", "tab_switch", "window_blur"] as const;

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
  "multi_display",
] as const;

export const VALID_EVENTS: string[] = [...COUNTED_EVENTS, ...LOGGED_ONLY];

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

/** Debounce before an edited draft is persisted. */
export const DRAFT_SAVE_MS = 2_000;

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
};
