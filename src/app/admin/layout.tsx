"use client";

// The shell every admin screen sits in.
//
// The admin gate lives here rather than being repeated per page, so no page can
// be added later that forgets it, and children only mount once the role is
// confirmed — a non-admin never sees a flash of the dashboard before the
// redirect lands.

import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { fetchJson } from "@/lib/fetch-json";

const NAV_GROUPS: { label: string; items: { href: string; label: string; exact?: boolean }[] }[] = [
  {
    label: "Monitor",
    items: [
      { href: "/admin", label: "Overview", exact: true },
      { href: "/admin/sessions", label: "Candidate runs" },
    ],
  },
  {
    label: "Records",
    items: [
      { href: "/admin/submissions", label: "Submissions" },
      { href: "/admin/events", label: "Proctor log" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/admin/assessments", label: "Tests" },
      { href: "/admin/problems", label: "Problem bank" },
      { href: "/admin/users", label: "Users" },
    ],
  },
];

/** How often the sidebar re-checks whether anyone is sitting a test. */
const LIVE_POLL_MS = 30_000;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isAdmin = (session?.user as any)?.role === "admin";

  const [live, setLive] = useState<{ live: number; online: number } | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
    else if (status === "authenticated" && !isAdmin) router.replace("/problems");
  }, [status, isAdmin, router]);

  const pollLive = useCallback(async () => {
    try {
      setLive(await fetchJson<{ live: number; online: number }>("/api/admin/live-count"));
    } catch {
      // A badge is not worth an error state — the pages themselves report their
      // own failures, including the 401 that means this browser lost admin.
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    pollLive();
    const t = setInterval(pollLive, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [isAdmin, pollLive]);

  if (status === "loading" || !isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500" />
      </div>
    );
  }

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  const liveBadge =
    live && live.live > 0 ? (
      <span className="ml-auto flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-300">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        {live.live}
      </span>
    ) : null;

  return (
    <div className="min-h-screen bg-gray-900 text-white lg:flex">
      {/* Sidebar — desktop */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col border-r border-gray-800 bg-gray-950 sticky top-0 h-screen">
        <div className="px-4 py-4 border-b border-gray-800">
          <Link href="/admin" className="block">
            <span className="text-lg font-bold">
              Code<span className="text-green-500">Test</span>
            </span>
            <span className="block text-[11px] text-purple-400">Admin</span>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="mb-4">
              <div className="px-4 pb-1.5 text-[10px] uppercase tracking-wider text-gray-600">
                {group.label}
              </div>
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-4 py-1.5 text-sm border-l-2 transition-colors ${
                    isActive(item.href, item.exact)
                      ? "border-green-500 bg-gray-900 text-white"
                      : "border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-900/50"
                  }`}
                >
                  {item.label}
                  {item.href === "/admin" && liveBadge}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-gray-800 px-4 py-3 text-xs">
          <div className="truncate text-gray-400" title={session?.user?.email ?? ""}>
            {session?.user?.email}
          </div>
          <div className="flex gap-3 mt-2">
            <Link href="/problems" className="text-gray-500 hover:text-gray-300">
              Candidate view
            </Link>
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="text-gray-500 hover:text-gray-300"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Nav — narrow screens */}
      <div className="lg:hidden border-b border-gray-800 bg-gray-950">
        <div className="px-4 pt-3 flex items-center justify-between">
          <span className="text-base font-bold">
            Code<span className="text-green-500">Test</span>
            <span className="text-[11px] text-purple-400 ml-1.5">Admin</span>
          </span>
          {liveBadge}
        </div>
        <nav className="flex gap-1 px-3 py-2 overflow-x-auto">
          {NAV_GROUPS.flatMap((g) => g.items).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3 py-1.5 rounded text-xs whitespace-nowrap ${
                isActive(item.href, item.exact)
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
