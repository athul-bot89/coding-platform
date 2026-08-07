import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { finalizeSession } from "@/lib/assessment";

/**
 * End a test: candidate pressed Finish, or their clock ran out.
 *
 * Deliberately does not use requireLiveSession — an already-finished session
 * should answer "you're done" rather than an error, so the client can always
 * redirect to the completion screen.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getServerSession(authOptions);
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const testSession = await prisma.testSession.findUnique({ where: { id: params.id } });
  if (!testSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (testSession.userId !== (auth.user as any).id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (testSession.state !== "in_progress") {
    return NextResponse.json({ state: testSession.state, alreadyFinished: true });
  }

  const { reason } = await req.json().catch(() => ({ reason: "manual" }));
  const expired = testSession.endsAt.getTime() <= Date.now();
  const state = expired || reason === "timeout" ? "auto_submitted" : "submitted";

  const finished = await finalizeSession(params.id, state);
  return NextResponse.json({ state: finished?.state ?? state, alreadyFinished: false });
}
