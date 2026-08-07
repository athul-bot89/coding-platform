"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isAdmin = (session?.user as any)?.role === "admin";

  useEffect(() => {
    if (session && isAdmin) {
      router.push("/problems");
    }
  }, [session, isAdmin, router]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
      </div>
    );
  }

  // Signed-in non-admin: show a proper landing instead of redirect-looping
  if (session && !isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white">
        <div className="text-center max-w-md px-4">
          <img
            src="https://www.botangelos.com/assets/img/Botangelos_white.png"
            alt="Botangelos"
            className="h-12 mx-auto mb-6"
          />
          <h1 className="text-2xl font-bold mb-2">Welcome, {session.user?.name ?? "Candidate"}!</h1>
          <p className="text-gray-400 mb-8">
            You&apos;re signed in as{" "}
            <span className="text-gray-300">{session.user?.email}</span>.
          </p>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 mb-6">
            <p className="text-sm text-gray-400">
              To start a coding assessment, use the invite link shared by your
              administrator. It will take you directly to your test.
            </p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="px-6 py-2 rounded-lg bg-gray-700 text-sm text-gray-300 hover:bg-gray-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-900 text-white">
      <div className="text-center max-w-2xl px-4">
        <img
          src="https://www.botangelos.com/assets/img/Botangelos_white.png"
          alt="Botangelos"
          className="h-16 mx-auto mb-6"
        />
        <p className="text-xl text-gray-400 mb-8">
          Online Coding Assessment Platform
        </p>
        <p className="text-gray-500 mb-12">
          Solve coding challenges, get instant feedback, and prove your skills.
        </p>
        <button
          onClick={() => signIn("google")}
          className="inline-flex items-center gap-3 bg-white text-gray-900 px-8 py-4 rounded-lg font-semibold text-lg hover:bg-gray-100 transition-colors"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
