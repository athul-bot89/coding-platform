"use client";

import { useEffect, useRef, useState } from "react";
import { FONT_MAX, FONT_MIN } from "@/lib/editor-layout";

interface EditorSettingsMenuProps {
  fontSize: number;
  onFontSize: (size: number) => void;
  /** Puts the split, the results drawer and the font size back to defaults. */
  onResetLayout: () => void;
  disabled?: boolean;
}

const FONT_STEP = 1;

/**
 * The gear beside the language picker: the parts of the editor's sizing that are
 * a setting rather than a drag. The panel sizes have their own handles.
 */
export function EditorSettingsMenu({
  fontSize,
  onFontSize,
  onResetLayout,
  disabled = false,
}: EditorSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    // Capture, so a click that lands on something which stops propagation still
    // dismisses the menu rather than leaving it stuck open over the editor.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Editor settings"
        className={`px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50 ${
          open ? "bg-gray-600" : "bg-gray-700 hover:bg-gray-600"
        }`}
      >
        ⚙︎ <span className="text-gray-400 tabular-nums">{fontSize}px</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Editor settings"
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border border-gray-600 bg-gray-800 p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-300">Font size</span>
            <span className="text-xs tabular-nums text-gray-500">{fontSize}px</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onFontSize(fontSize - FONT_STEP)}
              disabled={fontSize <= FONT_MIN}
              aria-label="Decrease font size"
              className="h-8 w-8 rounded bg-gray-700 text-lg leading-none hover:bg-gray-600 disabled:opacity-40"
            >
              −
            </button>
            <input
              type="range"
              min={FONT_MIN}
              max={FONT_MAX}
              step={FONT_STEP}
              value={fontSize}
              onChange={(e) => onFontSize(Number(e.target.value))}
              aria-label="Font size"
              className="flex-1 accent-green-500"
            />
            <button
              type="button"
              onClick={() => onFontSize(fontSize + FONT_STEP)}
              disabled={fontSize >= FONT_MAX}
              aria-label="Increase font size"
              className="h-8 w-8 rounded bg-gray-700 text-lg leading-none hover:bg-gray-600 disabled:opacity-40"
            >
              +
            </button>
          </div>

          <p className="mt-3 text-[11px] leading-snug text-gray-500">
            Drag the dividers to resize the problem panel and the results panel.
          </p>

          <button
            type="button"
            onClick={() => {
              onResetLayout();
              setOpen(false);
            }}
            className="mt-2 w-full rounded bg-gray-700 px-3 py-1.5 text-sm font-medium hover:bg-gray-600"
          >
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
}
