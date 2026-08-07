"use client";

import { useEffect, useRef } from "react";
import { DEDUPE_MS } from "@/lib/proctor-config";

interface ProctorGuardProps {
  /** Report an event. Called for both counted violations and blocked actions. */
  onEvent: (event: string, detail?: string) => void;
  /** Pause detection (e.g. while the fullscreen overlay is already showing). */
  enabled?: boolean;
}

/**
 * Blocks clipboard and inspection paths, and reports focus/fullscreen changes.
 *
 * Clipboard blocking is deliberately unconditional — there is no editor
 * exemption. Monaco installs its own clipboard handlers, so these listeners run
 * in the *capture* phase to fire before Monaco sees the event; the editor adds a
 * second layer by overriding the keybindings directly (see CodeEditor).
 */
export function ProctorGuard({ onEvent, enabled = true }: ProctorGuardProps) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const lastAt = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) return;

    // Alt-tab fires blur and visibilitychange back to back; without this a
    // single switch would burn two warnings.
    const report = (event: string, detail?: string) => {
      const now = Date.now();
      if (now - (lastAt.current[event] ?? 0) < DEDUPE_MS) return;
      lastAt.current[event] = now;
      onEventRef.current(event, detail);
    };

    const kill = (event: string) => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      report(event);
    };

    const handleCopy = kill("copy");
    const handleCut = kill("cut");
    const handlePaste = kill("paste");
    const handleDragStart = kill("drop");
    const handleDrop = kill("drop");

    const handleDragOver = (e: Event) => e.preventDefault();

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      report("right_click");
    };

    // Middle-click on X11 pastes the primary selection without ever firing a
    // clipboard event.
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        report("paste", "middle-click");
      }
    };

    const handleVisibility = () => {
      if (document.hidden) report("tab_switch");
    };

    const handleBlur = () => report("window_blur");

    const handleFullscreenChange = () => {
      if (!isFullscreen()) report("fullscreen_exit");
    };

    const handleBeforePrint = () => report("print");

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (e.ctrlKey || e.metaKey) {
        // Clipboard shortcuts — no editor exemption. Ctrl+A is left alone; it
        // does nothing on its own and blocking it just makes editing painful.
        if (["c", "v", "x"].includes(key)) {
          e.preventDefault();
          e.stopPropagation();
          report(key === "v" ? "paste" : key === "x" ? "cut" : "copy", `Ctrl+${key.toUpperCase()}`);
          return;
        }
        if (e.shiftKey && ["i", "j", "c"].includes(key)) {
          e.preventDefault();
          report("devtools", `Ctrl+Shift+${key.toUpperCase()}`);
          return;
        }
        if (key === "u") {
          e.preventDefault();
          report("devtools", "Ctrl+U");
          return;
        }
        if (key === "p") {
          e.preventDefault();
          report("print", "Ctrl+P");
          return;
        }
        if (key === "s") {
          e.preventDefault();
          return;
        }
      }

      if (e.key === "F12") {
        e.preventDefault();
        report("devtools", "F12");
      }
    };

    // Capture phase everywhere — this is what beats Monaco's own handlers.
    const cap = { capture: true } as const;
    document.addEventListener("copy", handleCopy, cap);
    document.addEventListener("cut", handleCut, cap);
    document.addEventListener("paste", handlePaste, cap);
    document.addEventListener("dragstart", handleDragStart, cap);
    document.addEventListener("dragover", handleDragOver, cap);
    document.addEventListener("drop", handleDrop, cap);
    document.addEventListener("contextmenu", handleContextMenu, cap);
    document.addEventListener("auxclick", handleAuxClick, cap);
    document.addEventListener("keydown", handleKeyDown, cap);
    document.addEventListener("visibilitychange", handleVisibility);
    for (const evt of FULLSCREEN_CHANGE_EVENTS) {
      document.addEventListener(evt, handleFullscreenChange);
    }
    window.addEventListener("blur", handleBlur);
    window.addEventListener("beforeprint", handleBeforePrint);

    // Two screens is the cheapest way to keep a solution visible without ever
    // leaving fullscreen. Report it once at start; it isn't counted.
    if (typeof window !== "undefined" && window.screen) {
      const s = window.screen as any;
      if (s.isExtended === true) {
        onEventRef.current("multi_display", "screen.isExtended");
      }
    }

    return () => {
      document.removeEventListener("copy", handleCopy, cap);
      document.removeEventListener("cut", handleCut, cap);
      document.removeEventListener("paste", handlePaste, cap);
      document.removeEventListener("dragstart", handleDragStart, cap);
      document.removeEventListener("dragover", handleDragOver, cap);
      document.removeEventListener("drop", handleDrop, cap);
      document.removeEventListener("contextmenu", handleContextMenu, cap);
      document.removeEventListener("auxclick", handleAuxClick, cap);
      document.removeEventListener("keydown", handleKeyDown, cap);
      document.removeEventListener("visibilitychange", handleVisibility);
      for (const evt of FULLSCREEN_CHANGE_EVENTS) {
        document.removeEventListener(evt, handleFullscreenChange);
      }
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("beforeprint", handleBeforePrint);
    };
  }, [enabled]);

  return null;
}

/**
 * Every browser that needs a prefix to *enter* fullscreen also prefixes the
 * change event and the element property, so detection has to cover the same
 * spread as `requestFullscreen` below. Listening only for the unprefixed event
 * would leave a WebKit candidate genuinely in fullscreen while the gate believed
 * they had left it — locked out of a test that is running fine.
 */
export const FULLSCREEN_CHANGE_EVENTS = [
  "fullscreenchange",
  "webkitfullscreenchange",
  "msfullscreenchange",
] as const;

export async function requestFullscreen(): Promise<boolean> {
  const elem = document.documentElement as any;
  const fn =
    elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen;
  if (!fn) return false;
  try {
    await fn.call(elem);
    return true;
  } catch {
    return false;
  }
}

export function isFullscreen(): boolean {
  const d = document as any;
  return !!(d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement);
}
