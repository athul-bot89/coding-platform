import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";
import { finalizeSession } from "@/lib/assessment";
import {
  VALID_EVENTS,
  isCountedEvent,
  isSilentEvent,
  truncateEventDetail,
} from "@/lib/proctor-config";

/**
 * Record a proctoring event. This endpoint — not the browser — decides whether
 * an event burns a warning and whether the test is over, so tampering with
 * client state gains nothing.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session, userId } = guard;

  const { event, detail, atMs } = await req.json().catch(() => ({ event: null }));

  if (!event || !VALID_EVENTS.includes(event)) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  const counted = isCountedEvent(event);

  await prisma.proctorEvent.create({
    data: {
      userId,
      sessionId: session.id,
      event,
      detail: truncateEventDetail(detail),
      counted,
      // Backdating is allowed for connection events only: they are reported once
      // the network is back, so stamping them "now" would put a two-minute outage
      // on the timeline at the moment it ended. Nothing that burns a warning can
      // be backdated — a candidate must not be able to move their own tab switch.
      ...(isSilentEvent(event) ? backdate(session.startedAt, atMs) : {}),
    },
  });

  // `counted` goes back to the client so the UI never has to guess which events
  // burn a warning. It used to infer that from the event name and told a
  // candidate "Warning 2 of 5" for a blocked right-click that had incremented
  // nothing.
  if (!counted) {
    return NextResponse.json({
      violationCount: session.violationCount,
      maxViolations: session.assessment.maxViolations,
      counted: false,
      terminated: false,
    });
  }

  const updated = await prisma.testSession.update({
    where: { id: session.id },
    data: { violationCount: { increment: 1 } },
  });

  const max = session.assessment.maxViolations;
  const terminated = max > 0 && updated.violationCount >= max;

  if (terminated) {
    await finalizeSession(session.id, "terminated");
  }

  return NextResponse.json({
    violationCount: updated.violationCount,
    maxViolations: max,
    counted: true,
    terminated,
  });
}

/**
 * Turn a client-supplied "this happened N ms into the test" into a createdAt,
 * clamped to the session's own window. An out-of-range or missing value falls
 * back to now by contributing nothing.
 */
function backdate(startedAt: Date, atMs: unknown): { createdAt?: Date } {
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) return {};
  const at = startedAt.getTime() + atMs;
  if (at > Date.now()) return {};
  return { createdAt: new Date(at) };
}
