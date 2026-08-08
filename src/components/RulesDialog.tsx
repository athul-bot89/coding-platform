"use client";

import { useEffect } from "react";
import { markdownToHtml } from "@/lib/markdown";

interface RulesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Admin-authored markdown for this assessment, if any. */
  instructions: string | null;
  /** Counted violations so far, so the warning budget reads as a live number. */
  violationCount: number;
  /** 0 means auto-submit is disabled for this assessment. */
  maxViolations: number;
}

/**
 * The rules the candidate agreed to before starting, available again mid-test
 * from the editor's settings menu. Nobody remembers a wall of text they read
 * once, and leaving the test to go looking for it is itself a violation.
 *
 * Read-only by design: it repeats policy, it never changes it.
 */
export function RulesDialog({
  open,
  onClose,
  instructions,
  violationCount,
  maxViolations,
}: RulesDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Note that Escape is also the browser's own fullscreen exit, which no
      // handler can cancel — so the panel closes rather than being left stranded
      // behind the fullscreen gate. It is deliberately not advertised as the way
      // to close this, since using it costs a warning.
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const remaining = maxViolations > 0 ? Math.max(0, maxViolations - violationCount) : null;

  return (
    <div
      className="fixed inset-0 z-[130] bg-black/80 flex items-center justify-center px-4 py-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Rules and instructions"
        onClick={(e) => e.stopPropagation()}
        className="bg-gray-800 border border-gray-700 rounded-xl w-full max-w-2xl max-h-full flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <h2 className="text-lg font-semibold">Rules &amp; instructions</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 rounded bg-gray-700 text-lg leading-none hover:bg-gray-600"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-6">
          {/* ---- Proctoring — the part that can end the test ---- */}
          <section>
            <h3 className="text-sm font-semibold text-red-300 mb-2">This test is proctored</h3>
            <ul className="space-y-1.5 text-xs text-gray-300">
              <li>
                • The test runs in <strong>fullscreen</strong>. Leaving fullscreen hides the test and
                records a warning.
              </li>
              <li>• Switching tabs or windows <strong>records a warning</strong>.</li>
              <li>
                • <strong>Multiple displays are not allowed.</strong> The test is blocked if an extra
                monitor is detected.
              </li>
              <li>
                • <strong>Copy and paste are completely disabled</strong> — including inside the code
                editor. These are simply blocked and do <strong>not</strong> use up a warning.
              </li>
              <li>• Right-click and developer tools are <strong>blocked</strong>.</li>
              <li>• Typing patterns are recorded to detect pasted code.</li>
              <li>
                • The timer runs on our servers. Closing the tab does <strong>not</strong> pause it.
              </li>
              <li>• Only one tab may hold the test. Opening it again evicts the older tab.</li>
            </ul>

            <div className="mt-3 rounded-lg bg-red-950/40 border border-red-900/60 px-3 py-2 text-xs text-gray-300">
              {maxViolations > 0 ? (
                <>
                  You have used <strong className="text-white">{violationCount}</strong> of{" "}
                  <strong className="text-white">{maxViolations}</strong> warnings.{" "}
                  {remaining === 0 ? (
                    <span className="text-red-300">
                      Your warning budget is used up — the next counted violation ends the test.
                    </span>
                  ) : (
                    <>
                      After {maxViolations} warnings your test is submitted automatically and you
                      cannot continue.
                    </>
                  )}
                </>
              ) : (
                <>
                  Violations are recorded and visible to the reviewer, but they do not
                  auto-submit this test. You have used{" "}
                  <strong className="text-white">{violationCount}</strong> so far.
                </>
              )}
            </div>
          </section>

          {/* ---- Whatever the admin wrote for this specific assessment ---- */}
          {instructions && (
            <section>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">
                Instructions for this test
              </h3>
              <div
                className="prose prose-invert prose-sm max-w-none text-gray-300"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(instructions) }}
              />
            </section>
          )}

          {/* ---- How to actually drive the screen ---- */}
          <section>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Using the editor</h3>
            <ul className="space-y-1.5 text-xs text-gray-300">
              <li>
                • <strong>Run samples</strong> checks your code against the visible sample cases
                only. It does not submit and does not score you.
              </li>
              <li>
                • <strong>Submit</strong> runs the full hidden test set and records the attempt. You
                may submit a question as many times as you like while time remains; your best
                submission counts.
              </li>
              <li>
                • <strong>Reset code</strong> discards your work for the current question and
                language and restores the starter template.
              </li>
              <li>
                • Switching questions keeps your code. Each question keeps its own code per
                language.
              </li>
              <li>
                • Your code is saved automatically, and also stored in this browser. If you go
                offline, keep working — it syncs when the connection returns and the lost time is
                added back to your clock.
              </li>
              <li>
                • Drag the dividers to resize the question panel and the results panel, or use the
                gear menu to change the font size and reset the layout.
              </li>
              <li>
                • <strong>Finish test</strong> ends the test for good, even if time remains.
              </li>
            </ul>
          </section>
        </div>

        <div className="px-6 py-4 border-t border-gray-700 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
          >
            Back to the test
          </button>
        </div>
      </div>
    </div>
  );
}
