"use client";

import { useCallback, useRef } from "react";

/** "x" divides two columns and drags sideways; "y" divides two rows and drags up. */
export type ResizeAxis = "x" | "y";

interface ResizeHandleProps {
  axis: ResizeAxis;
  /** Every pointer move during a drag, in viewport coordinates. */
  onMove: (clientX: number, clientY: number) => void;
  /**
   * One arrow-key press. Positive means the panel being sized grows — right for
   * an "x" handle, up for a "y" one — so callers can stay axis-agnostic.
   */
  onNudge: (steps: number) => void;
  /** Double-click, and the Home key: back to the default size. */
  onReset: () => void;
  label: string;
}

/**
 * The draggable seam between two panels.
 *
 * Pointer capture is what makes this usable: without it the drag would be lost
 * the moment the cursor crossed into Monaco, which swallows pointer events of
 * its own. With it, every move up to release is delivered here no matter what
 * the cursor is over.
 */
export function ResizeHandle({ axis, onMove, onNudge, onReset, label }: ResizeHandleProps) {
  const dragging = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Without this the drag selects whatever text it sweeps across in the
    // problem statement or the editor.
    document.body.classList.add("select-none");
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragging.current) onMove(e.clientX, e.clientY);
    },
    [onMove]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove("select-none");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // The capture is already gone — the pointer was lost rather than lifted.
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const grow = axis === "x" ? "ArrowRight" : "ArrowUp";
      const shrink = axis === "x" ? "ArrowLeft" : "ArrowDown";
      if (e.key === grow) onNudge(1);
      else if (e.key === shrink) onNudge(-1);
      else if (e.key === "Home") onReset();
      else return;
      // Arrows would otherwise scroll the panel the handle sits against.
      e.preventDefault();
    },
    [axis, onNudge, onReset]
  );

  const shared = {
    role: "separator" as const,
    tabIndex: 0,
    "aria-label": label,
    title: `${label} — drag, or use the arrow keys. Double-click to reset.`,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: onReset,
    onKeyDown: handleKeyDown,
  };

  if (axis === "x") {
    return (
      <div
        {...shared}
        aria-orientation="vertical"
        className="relative w-1.5 shrink-0 cursor-col-resize bg-gray-700 outline-none transition-colors hover:bg-green-600 focus-visible:bg-green-500"
      >
        {/* A 6px target is a fussy thing to hit, so the grab area reaches a few
            pixels into both neighbours without widening the visible seam. */}
        <div className="absolute inset-y-0 -left-1 -right-1" />
      </div>
    );
  }

  return (
    <div
      {...shared}
      aria-orientation="horizontal"
      className="relative h-1.5 shrink-0 cursor-row-resize bg-gray-700 outline-none transition-colors hover:bg-green-600 focus-visible:bg-green-500"
    >
      <div className="absolute inset-x-0 -top-1 -bottom-1" />
    </div>
  );
}
