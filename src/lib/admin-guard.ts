import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

/** Resolve an admin caller, or the 401/403 response to return instead. */
export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if ((session.user as any).role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { userId: (session.user as any).id as string };
}

/**
 * Resolve `?page=`/`?limit=` into values Prisma will accept.
 *
 * These arrive as untrusted text: `?page=abc` becomes a NaN `skip`, `?page=0` a
 * negative one, and `?limit=0` an Infinity page count in the response — each of
 * which surfaces as a 500 on an otherwise ordinary request. The ceiling on
 * `limit` stops a caller from asking for the whole table in one go.
 */
export function paginationParams(
  searchParams: URLSearchParams,
  { defaultLimit = 20, maxLimit = 100 } = {}
) {
  const page = clampInt(searchParams.get("page"), 1, 1, 100_000);
  const limit = clampInt(searchParams.get("limit"), defaultLimit, 1, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
