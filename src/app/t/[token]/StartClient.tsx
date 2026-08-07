"use client";

import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { markdownToHtml } from "@/lib/markdown";
import { requestFullscreen } from "@/components/ProctorGuard";

interface Props {
  token: string;
  signedInEmail: string | null;
  signedInName: string | null;
  resuming: boolean;
  assessment: {
    title: string;
    instructions: string | null;
    durationMinutes: number;
    maxViolations: number;
    questionCount: number;
    totalPoints: number;
    problems: { title: string; difficulty: string; points: number }[];
  };
}

export function StartClient(props: Props) {
  const { assessment } = props;
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  const testUrl = `/t/${props.token}`;
  const displayName = props.signedInName?.trim() || props.signedInEmail || "you";

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);

    // Fullscreen must be requested inside the click handler — the browser
    // rejects a programmatic request once the user gesture has been consumed by
    // an await. So we enter fullscreen first, then create the session.
    //
    // A refusal has to stop the start. Fullscreen is what the whole proctoring
    // story rests on: a session that never entered it can never leave it either,
    // so no fullscreen_exit is ever recorded and the candidate sits the entire
    // test windowed with reference material beside it, with nothing on the report
    // to say so. There is no session to attach a proctor event to yet, so the
    // candidate is told and the clock never starts — pressing Start again
    // retries, which is all a fresh user gesture needs.
    if (!(await requestFullscreen())) {
      setError(
        "This test must run in fullscreen and your browser would not allow it. Allow fullscreen for this site and press Start test again, or reopen this link in an up-to-date Chrome, Edge, Firefox or Safari."
      );
      setStarting(false);
      return;
    }

    try {
      const res = await fetch(`/api/tests/${props.token}/start`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not start the test.");
        setStarting(false);
        return;
      }
      router.replace(`/session/${data.sessionId}`);
    } catch {
      setError("Network error. Check your connection and try again.");
      setStarting(false);
    }
  };

  const Card = ({ children }: { children: React.ReactNode }) => (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-8">{children}</div>
  );

  const Summary = () => (
    <div className="grid grid-cols-3 gap-3 my-6">
      {[
        ["Duration", `${assessment.durationMinutes} min`],
        ["Questions", String(assessment.questionCount)],
        ["Total points", String(assessment.totalPoints)],
      ].map(([label, value]) => (
        <div key={label} className="bg-gray-900 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold">{value}</div>
          <div className="text-xs text-gray-500 mt-0.5">{label}</div>
        </div>
      ))}
    </div>
  );

  // ---- Not signed in -------------------------------------------------------
  if (!props.signedInEmail) {
    return (
      <Card>
        <p className="text-xs uppercase tracking-wider text-green-500 mb-2">Coding assessment</p>
        <h1 className="text-2xl font-bold">{assessment.title}</h1>
        <Summary />
        <p className="text-sm text-gray-400 mb-5">
          Sign in with your Google account to begin. The account you use identifies you on the
          results — you get <strong>one attempt</strong> per account.
        </p>
        <button
          onClick={() => signIn("google", { callbackUrl: testUrl })}
          className="w-full inline-flex items-center justify-center gap-3 bg-white text-gray-900 px-6 py-3 rounded-lg font-semibold hover:bg-gray-100 transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Sign in with Google
        </button>
        <p className="text-xs text-gray-600 mt-4 text-center">
          Your clock does not start until you press Start Test on the next screen.
        </p>
      </Card>
    );
  }

  // ---- Signed in: rules screen ---------------------------------------------
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-green-500 mb-2">
        {props.resuming ? "Resume in progress" : "Ready to begin"}
      </p>
      <h1 className="text-2xl font-bold">{assessment.title}</h1>
      <p className="text-sm text-gray-400 mt-1">
        {props.signedInName ? `${props.signedInName} · ` : ""}
        {props.signedInEmail}
      </p>

      <Summary />

      <div className="space-y-1.5 mb-6">
        {assessment.problems.map((p, i) => (
          <div
            key={i}
            className="flex items-center justify-between bg-gray-900 rounded px-3 py-2 text-sm"
          >
            <span>
              <span className="text-gray-500 mr-2">Q{i + 1}</span>
              {p.title}
            </span>
            <span className="text-xs text-gray-500">{p.points} pts</span>
          </div>
        ))}
      </div>

      {assessment.instructions && (
        <div
          className="prose prose-invert prose-sm max-w-none mb-6 text-gray-300"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(assessment.instructions) }}
        />
      )}

      <div className="bg-red-950/40 border border-red-900/60 rounded-lg p-4 mb-5">
        <h3 className="font-semibold text-red-300 text-sm mb-2">This test is proctored</h3>
        <ul className="space-y-1.5 text-xs text-gray-300">
          <li>• The test runs in <strong>fullscreen</strong>. Leaving fullscreen hides the test and records a warning.</li>
          <li>• Switching tabs or windows <strong>records a warning</strong>.</li>
          {assessment.maxViolations > 0 && (
            <li>
              • After <strong>{assessment.maxViolations} warnings</strong> your test is submitted
              automatically and you cannot continue.
            </li>
          )}
          <li>
            • <strong>Copy and paste are completely disabled</strong> — including inside the code
            editor. These are simply blocked and do <strong>not</strong> use up a warning.
          </li>
          <li>• The timer runs on our servers. Closing the tab does <strong>not</strong> pause it.</li>
          <li>• Typing patterns are recorded to detect pasted code.</li>
          {!props.resuming && (
            <li>
              • You get <strong>one attempt</strong>. Once you start, this link will not give you a
              second one.
            </li>
          )}
        </ul>
      </div>

      {props.resuming && (
        <div className="bg-yellow-950/40 border border-yellow-900/60 rounded-lg p-3 mb-5 text-xs text-yellow-200">
          You already started this test. Your remaining time has continued to count down and your
          saved code will be restored.
        </div>
      )}

      <label className="flex items-start gap-2.5 mb-5 cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-green-600"
        />
        <span className="text-xs text-gray-400">
          I understand the rules above and confirm I am {displayName}, completing this test without
          assistance.
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 rounded px-3 py-2 mb-4">{error}</p>
      )}

      <button
        onClick={handleStart}
        disabled={!agreed || starting}
        className="w-full px-6 py-4 bg-green-600 rounded-lg font-semibold text-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? "Starting…" : props.resuming ? "Resume test" : "Start test"}
      </button>
      <p className="text-xs text-gray-600 mt-3 text-center">
        {props.resuming
          ? "Your clock is already running."
          : `Your ${assessment.durationMinutes}-minute clock starts the moment you press this.`}
      </p>

      {/* Shared links get opened on whatever account the browser happens to be
          holding, so switching is a first-class action here rather than an
          error state. Offered before Start, since afterwards the run is bound
          to this account for good. */}
      {!props.resuming && (
        <button
          onClick={() => signOut({ callbackUrl: testUrl })}
          className="w-full mt-3 text-xs text-gray-500 hover:text-gray-300"
        >
          Not {displayName}? Sign in with a different account
        </button>
      )}
    </Card>
  );
}
