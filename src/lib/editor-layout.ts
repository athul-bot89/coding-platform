// The candidate's own sizing of the test screen: how wide the problem statement
// is, how tall the results drawer is, and how big the code is set.
//
// Kept on the candidate's machine, not the server. It is a comfort setting, not
// part of the attempt — a stale or missing value costs nothing but a default
// layout, so it is never worth a network call or a schema column.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface EditorLayout {
  /** Problem panel width, as a percentage of the row it shares with the editor. */
  splitPct: number;
  /** Results drawer height, in CSS pixels. */
  resultsPx: number;
  /** Monaco font size, in CSS pixels. */
  fontSize: number;
}

export const DEFAULT_LAYOUT: EditorLayout = {
  // 40% and 224px are what the screen was fixed at before it could be dragged
  // (`w-2/5` and `h-56`), so an untouched layout looks exactly as it always has.
  splitPct: 40,
  resultsPx: 224,
  fontSize: 14,
};

/**
 * Bounds every stored and dragged value. The minimums exist so a careless drag
 * cannot leave a candidate mid-exam with a panel too small to use and a handle
 * too small to grab back.
 */
const LIMITS: Record<keyof EditorLayout, { min: number; max: number }> = {
  splitPct: { min: 20, max: 70 },
  resultsPx: { min: 96, max: 640 },
  fontSize: { min: 10, max: 28 },
};

export const FONT_MIN = LIMITS.fontSize.min;
export const FONT_MAX = LIMITS.fontSize.max;

/** Keyboard nudge per arrow press: pixels for the drawer, percent for the split. */
export const NUDGE_PX = 24;
export const NUDGE_PCT = 2;

const STORAGE_KEY = "editor-layout:v1";

function clampValue(key: keyof EditorLayout, value: number): number {
  const { min, max } = LIMITS[key];
  // A NaN in from a corrupted store or a zero-width measurement must not
  // propagate into a style attribute, where it would collapse the panel.
  if (!Number.isFinite(value)) return DEFAULT_LAYOUT[key];
  return Math.min(max, Math.max(min, value));
}

function clampLayout(layout: EditorLayout): EditorLayout {
  return {
    // Sub-pixel precision here would only make the persisted value noisy.
    splitPct: Math.round(clampValue("splitPct", layout.splitPct) * 100) / 100,
    resultsPx: Math.round(clampValue("resultsPx", layout.resultsPx)),
    fontSize: Math.round(clampValue("fontSize", layout.fontSize)),
  };
}

function sameLayout(a: EditorLayout, b: EditorLayout): boolean {
  return (
    a.splitPct === b.splitPct && a.resultsPx === b.resultsPx && a.fontSize === b.fontSize
  );
}

function readLayout(): EditorLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Each field is taken only if it is a usable number, so a half-written or
    // older-shaped record still contributes whatever it does have.
    return clampLayout({
      splitPct: typeof parsed.splitPct === "number" ? parsed.splitPct : DEFAULT_LAYOUT.splitPct,
      resultsPx: typeof parsed.resultsPx === "number" ? parsed.resultsPx : DEFAULT_LAYOUT.resultsPx,
      fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_LAYOUT.fontSize,
    });
  } catch {
    return null;
  }
}

function writeLayout(layout: EditorLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Private mode or a full quota. The layout still works for this sitting; it
    // just will not be remembered, which is not worth telling a candidate about
    // mid-test — and never worth throwing inside the test screen.
  }
}

export interface EditorLayoutControls {
  layout: EditorLayout;
  /** Merges a partial change, clamped to the limits above. */
  set: (patch: Partial<EditorLayout>) => void;
  reset: () => void;
}

export function useEditorLayout(): EditorLayoutControls {
  const [layout, setLayout] = useState<EditorLayout>(DEFAULT_LAYOUT);

  // Deliberately not read during the first render: localStorage does not exist
  // on the server, so a stored layout would make the client's markup disagree
  // with the server's and blow up hydration. One frame at the default costs
  // nothing next to that.
  useEffect(() => {
    const stored = readLayout();
    if (stored) setLayout(stored);
  }, []);

  const set = useCallback((patch: Partial<EditorLayout>) => {
    setLayout((prev) => {
      const next = clampLayout({ ...prev, ...patch });
      // Pointer moves arrive far faster than the layout can actually change, and
      // every one of them is identical once the drag is pinned at a limit.
      return sameLayout(prev, next) ? prev : next;
    });
  }, []);

  const reset = useCallback(() => setLayout(DEFAULT_LAYOUT), []);

  // Written on a trailing timer rather than per change: a drag produces a state
  // update per pointer move, and only the one the candidate stops on matters.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => writeLayout(layout), 250);
    return () => clearTimeout(timer);
  }, [layout]);

  return { layout, set, reset };
}
