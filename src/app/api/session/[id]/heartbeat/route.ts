import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";
import { remainingMs } from "@/lib/assessment";

/**
 * Liveness ping and clock re-sync, every HEARTBEAT_MS.
 *
 * Also enforces the single-tab rule. Ownership is claimed by loading the test
 * screen (see the session GET), not here — so the most recently *opened* tab
 * wins and every older tab learns it has been evicted on its next ping. That
 * makes a refresh seamless while still shutting down side-by-side tabs, which
 * would otherwise race on drafts and double-submit.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session } = guard;

  const { tabId } = await req.json().catch(() => ({ tabId: null }));

  if (tabId && session.tabLock && session.tabLock !== tabId) {
    return NextResponse.json({ evicted: true }, { status: 409 });
  }

  await prisma.testSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date(), ...(tabId ? { tabLock: tabId } : {}) },
  });

  return NextResponse.json({
    evicted: false,
    remainingMs: remainingMs(session.endsAt),
    violationCount: session.violationCount,
    maxViolations: session.invitation.assessment.maxViolations,
  });
}
