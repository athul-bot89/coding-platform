import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { finalizeSession } from "@/lib/assessment";

/**
 * Resolve the caller's own in-progress TestSession, or an error response.
 *
 * Every session endpoint goes through this so ownership, liveness and the clock
 * are checked in exactly one place. A session found past its `endsAt` is
 * finalized here rather than being allowed to accept one more request.
 */
export async function requireLiveSession(sessionId: string) {
  const auth = await getServerSession(authOptions);
  if (!auth?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const userId = (auth.user as any).id;

  const testSession = await prisma.testSession.findUnique({
    where: { id: sessionId },
    include: {
      invitation: {
        include: {
          assessment: {
            include: {
              problems: {
                include: { problem: { include: { testCases: { orderBy: { ordinal: "asc" } } } } },
                orderBy: { ordinal: "asc" },
              },
            },
          },
        },
      },
    },
  });

  if (!testSession) {
    return { error: NextResponse.json({ error: "Session not found" }, { status: 404 }) };
  }

  if (testSession.userId !== userId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  if (testSession.state !== "in_progress") {
    return {
      error: NextResponse.json(
        { error: "This test has ended", state: testSession.state, ended: true },
        { status: 409 }
      ),
    };
  }

  if (testSession.endsAt.getTime() <= Date.now()) {
    await finalizeSession(sessionId, "auto_submitted");
    return {
      error: NextResponse.json(
        { error: "Time is up", state: "auto_submitted", ended: true },
        { status: 409 }
      ),
    };
  }

  return { session: testSession, userId };
}

export type LiveSession = NonNullable<Awaited<ReturnType<typeof requireLiveSession>>["session"]>;
