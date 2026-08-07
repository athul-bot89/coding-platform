"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import { BURST_CHARS } from "@/lib/proctor-config";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export { getMonacoLanguage } from "@/lib/languages";

export interface EditChange {
  /** Characters inserted by this single edit. */
  chars: number;
  /** True when the insertion is too large to have been typed. */
  isBurst: boolean;
}

interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string) => void;
  /** Locks the editor down: kills clipboard commands and the context menu. */
  proctored?: boolean;
  /** Called for every content change when proctored — feeds integrity metrics. */
  onEdit?: (change: EditChange) => void;
  /** Report a blocked clipboard attempt made through Monaco's own keybindings. */
  onBlocked?: (event: string, detail?: string) => void;
  readOnly?: boolean;
}

export function CodeEditor({
  language,
  value,
  onChange,
  proctored = false,
  onEdit,
  onBlocked,
  readOnly = false,
}: CodeEditorProps) {
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  const handleMount = (editor: any, monaco: any) => {
    if (!proctored) return;

    // Layer 2 of the clipboard block. The document-level capture listeners in
    // ProctorGuard stop the browser's clipboard events, but Monaco also routes
    // Ctrl+C/V/X through its own command system, so those keybindings have to be
    // overridden here as well.
    const { KeyMod, KeyCode } = monaco;
    const blocked: [number, string, string][] = [
      [KeyMod.CtrlCmd | KeyCode.KeyV, "paste", "monaco Ctrl+V"],
      [KeyMod.CtrlCmd | KeyCode.KeyC, "copy", "monaco Ctrl+C"],
      [KeyMod.CtrlCmd | KeyCode.KeyX, "cut", "monaco Ctrl+X"],
      [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV, "paste", "monaco Ctrl+Shift+V"],
      [KeyMod.CtrlCmd | KeyCode.Insert, "copy", "monaco Ctrl+Insert"],
      [KeyMod.Shift | KeyCode.Insert, "paste", "monaco Shift+Insert"],
    ];
    for (const [keybinding, event, detail] of blocked) {
      editor.addCommand(keybinding, () => onBlockedRef.current?.(event, detail));
    }

    // Layer 5: whatever slips through still has to arrive as characters, and a
    // single large insertion is paste-shaped no matter how it got there.
    editor.onDidChangeModelContent((e: any) => {
      let chars = 0;
      for (const change of e.changes) {
        chars += change.text?.length ?? 0;
      }
      if (chars > 0) {
        onEditRef.current?.({ chars, isBurst: chars > BURST_CHARS });
      }
    });
  };

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={(v) => onChange(v || "")}
      theme="vs-dark"
      onMount={handleMount}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        automaticLayout: true,
        tabSize: 4,
        readOnly,
        // Kills the right-click menu's Copy/Paste entries outright.
        contextmenu: !proctored,
        // Drag-and-drop text into the editor is a clipboard bypass.
        dragAndDrop: !proctored,
        dropIntoEditor: { enabled: !proctored },
      }}
    />
  );
}
