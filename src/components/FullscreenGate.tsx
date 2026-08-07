"use client";

import { useEffect, useState } from "react";
import {
  FULLSCREEN_CHANGE_EVENTS,
  isFullscreen,
  requestFullscreen,
} from "@/components/ProctorGuard";
import {
  violationLevel,
  VIOLATION_BADGES,
  VIOLATION_OVERLAY,
} from "@/lib/proctor-config";

interface Props {
  violationCount: number;
  maxViolations: number;
  /** Rendered underneath the overlay — kept mounted so editor state survives. */
  children: React.ReactNode;
}

/**
 * Hides the test whenever the browser is not in fullscreen.
 *
 * The "Return to fullscreen" button is not a convenience — it is required. The
 * Fullscreen API only accepts a request that originates from a user gesture, and
 * Escape cannot be intercepted, so there is no way to restore fullscreen
 * automatically. The clock keeps running the entire time the overlay is up.
 */
export function FullscreenGate({ violationCount, maxViolations, children }: Props) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    // Detection has to match the prefixed spread `requestFullscreen` uses, or a
    // browser that entered fullscreen through a prefix sits behind this overlay
    // forever with its clock running.
    const sync = () => setBlocked(!isFullscreen());
    sync();
    for (const evt of FULLSCREEN_CHANGE_EVENTS) {
      document.addEventListener(evt, sync);
    }
    return () => {
      for (const evt of FULLSCREEN_CHANGE_EVENTS) {
        document.removeEventListener(evt, sync);
      }
    };
  }, []);

  // The overlay used to lead with a 3xl "2 / 5". It now leads with how serious
  // this is instead of how much room is left — see VIOLATION_OVERLAY.
  const level = violationLevel(violationCount, maxViolations);

  return (
    <>
      {/* Kept mounted, only hidden — unmounting would throw away unsaved code. */}
      <div className={blocked ? "invisible pointer-events-none" : ""} aria-hidden={blocked}>
        {children}
      </div>

      {blocked && (
        <div className="fixed inset-0 z-[100] bg-gray-950 flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="text-5xl mb-5">⛶</div>
            <h2 className="text-2xl font-bold text-white mb-3">You left fullscreen</h2>
            <p className="text-gray-400 text-sm mb-6">
              This test must stay in fullscreen. Your test is hidden until you return —{" "}
              <strong className="text-red-400">the timer is still running.</strong>
            </p>

            {level !== "none" && (
              <div className="bg-red-950/50 border border-red-900 rounded-lg p-4 mb-6">
                <div className="text-sm font-semibold text-red-400 mb-1">
                  {VIOLATION_BADGES[level]}
                </div>
                <div className="text-xs text-red-300">{VIOLATION_OVERLAY[level]}</div>
              </div>
            )}

            <button
              onClick={() => requestFullscreen()}
              className="w-full px-6 py-4 bg-green-600 rounded-lg font-semibold text-lg text-white hover:bg-green-700 transition-colors"
            >
              Return to fullscreen
            </button>
          </div>
        </div>
      )}
    </>
  );
}
