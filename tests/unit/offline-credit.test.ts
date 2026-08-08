import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked so importing @/lib/assessment doesn't pull a real Prisma client in.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    testSession: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/grading", () => ({ pollAndScoreAttempt: vi.fn() }));

import {
  remainingCreditMs,
  pendingOfflineCreditMs,
  applyOfflineCredit,
  sessionElapsedMs,
  remainingMs,
} from "@/lib/assessment";
import { prisma } from "@/lib/prisma";
import {
  HEARTBEAT_MS,
  OFFLINE_CREDIT_MIN_MS,
  MAX_OFFLINE_CREDIT_MS,
} from "@/lib/proctor-config";

const mockPrisma = vi.mocked(prisma, true);

/** Fixed clock — these functions all take `now`, so nothing here needs fake timers. */
const NOW = 1_700_000_000_000;

function session(over: Partial<{ endsAt: number; lastSeenAt: number; creditedMs: number }> = {}) {
  return {
    id: "sess-1",
    endsAt: new Date(over.endsAt ?? NOW + 30 * 60_000),
    lastSeenAt: new Date(over.lastSeenAt ?? NOW),
    creditedMs: over.creditedMs ?? 0,
  };
}

describe("remainingCreditMs", () => {
  it("is the full budget for a session that has been credited nothing", () => {
    expect(remainingCreditMs({ creditedMs: 0 })).toBe(MAX_OFFLINE_CREDIT_MS);
  });

  it("shrinks by what has already been granted", () => {
    expect(remainingCreditMs({ creditedMs: 60_000 })).toBe(MAX_OFFLINE_CREDIT_MS - 60_000);
  });

  it("never goes negative once the budget is spent", () => {
    expect(remainingCreditMs({ creditedMs: MAX_OFFLINE_CREDIT_MS })).toBe(0);
    expect(remainingCreditMs({ creditedMs: MAX_OFFLINE_CREDIT_MS + 5 * 60_000 })).toBe(0);
  });
});

describe("pendingOfflineCreditMs", () => {
  it("credits nothing for the normal quiet between heartbeats", () => {
    const gap = OFFLINE_CREDIT_MIN_MS - 1;
    expect(pendingOfflineCreditMs(session({ lastSeenAt: NOW - gap }), NOW)).toBe(0);
  });

  it("starts crediting once the gap reaches the two-beat floor", () => {
    // At the floor exactly, one beat of the gap is still treated as normal quiet.
    expect(
      pendingOfflineCreditMs(session({ lastSeenAt: NOW - OFFLINE_CREDIT_MIN_MS }), NOW)
    ).toBe(OFFLINE_CREDIT_MIN_MS - HEARTBEAT_MS);
  });

  it("measures the outage from the beat that was missed, not the last one sent", () => {
    // Away for 60s => 50s of it is unaccounted-for silence, one beat is not.
    const away = 60_000;
    expect(pendingOfflineCreditMs(session({ lastSeenAt: NOW - away }), NOW)).toBe(
      away - HEARTBEAT_MS
    );
  });

  it("credits nothing when the clock had already run out as the outage began", () => {
    // Deadline sits before the missed beat: dropping at the buzzer buys nothing...
    const s = session({ lastSeenAt: NOW - 5 * 60_000, endsAt: NOW - 5 * 60_000 + HEARTBEAT_MS });
    expect(pendingOfflineCreditMs(s, NOW)).toBe(0);
  });

  it("cannot rescue a session that stayed away far longer than the budget", () => {
    // Dropped with a minute left and gone an hour: the grant is capped, so the
    // deadline it restores is still in the past and the test stays over.
    const away = 60 * 60_000;
    const s = session({ lastSeenAt: NOW - away, endsAt: NOW - away + 60_000 });
    const grant = pendingOfflineCreditMs(s, NOW);

    expect(grant).toBe(MAX_OFFLINE_CREDIT_MS);
    expect(s.endsAt.getTime() + grant).toBeLessThan(NOW);
  });

  it("credits an outage that began with time left and spanned the deadline", () => {
    // Dropped with 30s left, gone 10 minutes: the test must still be finishable.
    const away = 10 * 60_000;
    const s = session({ lastSeenAt: NOW - away, endsAt: NOW - away + 30_000 });
    expect(pendingOfflineCreditMs(s, NOW)).toBe(away - HEARTBEAT_MS);
  });

  it("clamps a long outage to the per-session budget", () => {
    const s = session({ lastSeenAt: NOW - 3 * MAX_OFFLINE_CREDIT_MS });
    expect(pendingOfflineCreditMs(s, NOW)).toBe(MAX_OFFLINE_CREDIT_MS);
  });

  it("clamps to what is left of the budget after earlier outages", () => {
    const spent = MAX_OFFLINE_CREDIT_MS - 60_000;
    const s = session({ lastSeenAt: NOW - 5 * 60_000, creditedMs: spent });
    expect(pendingOfflineCreditMs(s, NOW)).toBe(60_000);
  });

  it("credits nothing once the budget is exhausted, however long the outage", () => {
    const s = session({ lastSeenAt: NOW - 30 * 60_000, creditedMs: MAX_OFFLINE_CREDIT_MS });
    expect(pendingOfflineCreditMs(s, NOW)).toBe(0);
  });
});

describe("applyOfflineCredit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockPrisma.testSession.updateMany as any).mockResolvedValue({ count: 1 });
  });

  it("is a no-op that touches no rows when nothing is owed", async () => {
    const s = session();
    const { session: after, grantedMs } = await applyOfflineCredit(s, NOW);

    expect(grantedMs).toBe(0);
    expect(after).toBe(s);
    expect(mockPrisma.testSession.updateMany).not.toHaveBeenCalled();
  });

  it("pushes endsAt out by the grant and records it against the budget", async () => {
    const away = 5 * 60_000;
    const s = session({ lastSeenAt: NOW - away });
    const expected = away - HEARTBEAT_MS;

    const { session: after, grantedMs } = await applyOfflineCredit(s, NOW);

    expect(grantedMs).toBe(expected);
    expect(after.endsAt.getTime()).toBe(s.endsAt.getTime() + expected);
    expect(after.creditedMs).toBe(expected);
    expect(after.lastSeenAt.getTime()).toBe(NOW);
  });

  it("claims the grant against the lastSeenAt it was computed from", async () => {
    // The compare-and-swap is what stops two requests arriving after one outage
    // from each extending the deadline by the whole gap.
    const s = session({ lastSeenAt: NOW - 5 * 60_000 });
    await applyOfflineCredit(s, NOW);

    expect(mockPrisma.testSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: s.id, state: "in_progress", lastSeenAt: s.lastSeenAt },
      })
    );
  });

  it("grants nothing and re-reads when another request claimed the same outage", async () => {
    (mockPrisma.testSession.updateMany as any).mockResolvedValue({ count: 0 });
    const winner = {
      endsAt: new Date(NOW + 35 * 60_000),
      creditedMs: 290_000,
      lastSeenAt: new Date(NOW),
    };
    (mockPrisma.testSession.findUnique as any).mockResolvedValue(winner);

    const s = session({ lastSeenAt: NOW - 5 * 60_000 });
    const { session: after, grantedMs } = await applyOfflineCredit(s, NOW);

    expect(grantedMs).toBe(0);
    expect(after.endsAt).toEqual(winner.endsAt);
    expect(after.creditedMs).toBe(winner.creditedMs);
  });

  it("keeps the caller's copy when the lost race leaves nothing to re-read", async () => {
    (mockPrisma.testSession.updateMany as any).mockResolvedValue({ count: 0 });
    (mockPrisma.testSession.findUnique as any).mockResolvedValue(null);

    const s = session({ lastSeenAt: NOW - 5 * 60_000 });
    const { session: after, grantedMs } = await applyOfflineCredit(s, NOW);

    expect(grantedMs).toBe(0);
    expect(after).toBe(s);
  });
});

describe("sessionElapsedMs", () => {
  const startedAt = new Date(NOW - 60 * 60_000);

  it("runs to the submission for a test the candidate ended", () => {
    const submittedAt = new Date(NOW - 30 * 60_000);
    const s = { startedAt, submittedAt, endsAt: new Date(NOW) };
    expect(sessionElapsedMs(s, NOW)).toBe(30 * 60_000);
  });

  it("runs to now for a test still in progress", () => {
    const s = { startedAt, submittedAt: null, endsAt: new Date(NOW + 60_000) };
    expect(sessionElapsedMs(s, NOW)).toBe(60 * 60_000);
  });

  it("stops at the deadline for an abandoned test, so the duration cannot grow", () => {
    const endsAt = new Date(NOW - 20 * 60_000);
    const s = { startedAt, submittedAt: null, endsAt };
    expect(sessionElapsedMs(s, NOW)).toBe(40 * 60_000);
    // Same answer an hour later — nobody works past the buzzer.
    expect(sessionElapsedMs(s, NOW + 60 * 60_000)).toBe(40 * 60_000);
  });

  it("caps a submission stamped after the deadline at the deadline", () => {
    const s = {
      startedAt,
      submittedAt: new Date(NOW + 10 * 60_000),
      endsAt: new Date(NOW - 10 * 60_000),
    };
    expect(sessionElapsedMs(s, NOW)).toBe(50 * 60_000);
  });

  it("never reports negative time", () => {
    const s = { startedAt, submittedAt: new Date(NOW - 90 * 60_000), endsAt: new Date(NOW) };
    expect(sessionElapsedMs(s, NOW)).toBe(0);
  });
});

describe("remainingMs", () => {
  it("floors at zero once the deadline has passed", () => {
    expect(remainingMs(new Date(Date.now() - 5_000))).toBe(0);
  });

  it("is positive while there is time left", () => {
    expect(remainingMs(new Date(Date.now() + 60_000))).toBeGreaterThan(0);
  });
});
