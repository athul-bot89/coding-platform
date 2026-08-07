import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";
import { remainingMs, remainingCreditMs } from "@/lib/assessment";

/**
 * Liveness ping and clock re-sync, every HEARTBEAT_MS — and, while the connection
 * is down, every OFFLINE_PROBE_MS, since this is also how the client discovers it
 * is back.
 *
 * Time lost to an outage has already been credited by the guard; `grantedMs` is
 * what this beat recovered, so the candidate can be told their clock moved rather
 * than being left to wonder.
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
  const { session, grantedMs } = guard;

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
    maxViolations: session.assessment.maxViolations,
    /** Time this beat recovered, in ms. Zero on all but the first beat back. */
    grantedMs,
    /** Total credited to this session so far, and what is left of the budget. */
    creditedMs: session.creditedMs,
    creditLeftMs: remainingCreditMs(session),
  });
}
