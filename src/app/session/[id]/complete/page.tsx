"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

const MESSAGES: Record<string, { icon: string; title: string; body: string }> = {
  manual: {
    icon: "✅",
    title: "Test submitted",
    body: "Your answers have been recorded and sent to the hiring team.",
  },
  timeout: {
    icon: "⏱",
    title: "Time's up",
    body: "Your time ran out and everything you submitted has been recorded automatically.",
  },
  terminated: {
    icon: "🚫",
    title: "Test ended early",
    body: "Your test was submitted automatically because the proctoring limit was reached. The hiring team will see your work along with the recorded activity.",
  },
};

function CompleteBody() {
  const reason = useSearchParams().get("reason") ?? "manual";
  const msg = MESSAGES[reason] ?? MESSAGES.manual;

  // Nothing left to proctor — release fullscreen so the candidate isn't trapped.
  useEffect(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-10 text-center">
      <div className="text-5xl mb-5">{msg.icon}</div>
      <h1 className="text-2xl font-bold mb-3">{msg.title}</h1>
      <p className="text-sm text-gray-400 leading-relaxed">{msg.body}</p>
      <p className="text-xs text-gray-600 mt-8">
        You can close this window. Results are not shown to candidates.
      </p>
    </div>
  );
}

export default function CompletePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
      <div className="w-full max-w-md">
        <Suspense fallback={null}>
          <CompleteBody />
        </Suspense>
      </div>
    </div>
  );
}
