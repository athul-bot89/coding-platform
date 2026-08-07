"use client";

import { useEffect, useState } from "react";
import { isMultiDisplay } from "@/components/ProctorGuard";

interface Props {
  children: React.ReactNode;
}

/**
 * Hides the test whenever multiple displays are detected.
 *
 * Polls `screen.isExtended` because there is no universally supported event for
 * display connect/disconnect. The overlay disappears the moment the extra
 * monitor is unplugged — no action required from the candidate beyond
 * disconnecting it.
 */
export function MultiDisplayGate({ children }: Props) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const sync = () => setBlocked(isMultiDisplay());
    sync();
    const id = setInterval(sync, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <div className={blocked ? "invisible pointer-events-none" : ""} aria-hidden={blocked}>
        {children}
      </div>

      {blocked && (
        <div className="fixed inset-0 z-[101] bg-gray-950 flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="text-5xl mb-5">🖥️</div>
            <h2 className="text-2xl font-bold text-white mb-3">Multiple displays detected</h2>
            <p className="text-gray-400 text-sm mb-6">
              This test requires a single display. Please disconnect all extra monitors or screens.
              The test will resume automatically once only one display is active —{" "}
              <strong className="text-red-400">the timer is still running.</strong>
            </p>

            <div className="bg-red-950/50 border border-red-900 rounded-lg p-4">
              <div className="text-xs text-red-300">
                This event has been recorded and counts as a warning.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
