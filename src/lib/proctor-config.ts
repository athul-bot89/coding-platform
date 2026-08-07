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

export function isCountedEvent(event: string): boolean {
  return (COUNTED_EVENTS as readonly string[]).includes(event);
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

/** Default validity window for a freshly generated invite link. */
export const INVITE_VALID_DAYS = 7;

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
