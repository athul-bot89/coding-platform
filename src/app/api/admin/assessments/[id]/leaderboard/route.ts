import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { buildLeaderboard, sweepExpiredSessions } from "@/lib/assessment";

/** Ranked standings for one test. Admin-only — candidates never see this. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  // Abandoned tests are scored here rather than sitting at their pre-finalize
  // total, so a candidate who closed their laptop is ranked on what they did.
  await sweepExpiredSessions();

  const board = await buildLeaderboard(params.id);
  if (!board) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(board);
}
