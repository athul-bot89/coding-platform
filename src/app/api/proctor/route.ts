import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { VALID_EVENTS, isCountedEvent, truncateEventDetail } from "@/lib/proctor-config";

/**
 * Log anti-cheat events from the un-proctored practice flow.
 *
 * The whitelist and the counted/logged-only split live in lib/proctor-config so
 * this route and /api/session/[id]/event agree on what a valid event is. There is
 * no violation counter to increment out here, but `counted` still records which
 * class the event fell into so a practice log reads the same as a session one.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { event, detail, attemptId } = await req.json().catch(() => ({}));

  if (typeof event !== "string" || !VALID_EVENTS.includes(event)) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  await prisma.proctorEvent.create({
    data: {
      userId: (session.user as any).id,
      attemptId: typeof attemptId === "string" && attemptId ? attemptId : null,
      event,
      detail: truncateEventDetail(detail),
      counted: isCountedEvent(event),
    },
  });

  return NextResponse.json({ ok: true });
}
