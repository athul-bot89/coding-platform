import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { generateJoinToken, testUrl } from "@/lib/assessment";

/**
 * Issue a fresh join token, invalidating every copy of the old link at once.
 *
 * The only control there is over a link anyone can forward. Sessions already
 * under way are untouched — they are keyed on the assessment, not the token —
 * so rotating mid-test locks out newcomers without ejecting anyone working.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const exists = await prisma.assessment.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.assessment.update({
    where: { id: params.id },
    data: { joinToken: generateJoinToken() },
  });

  return NextResponse.json({ joinUrl: testUrl(updated.joinToken) });
}
