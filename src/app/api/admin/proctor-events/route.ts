import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, paginationParams } from "@/lib/admin-guard";
import { VALID_EVENTS } from "@/lib/proctor-config";

/**
 * The proctor log, with everyone named.
 *
 * ProctorEvent carries a bare `userId` and no relation to User, so identities are
 * resolved in a second query rather than a join — otherwise the log reads as a
 * wall of truncated cuids that no admin can act on.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const sessionId = searchParams.get("sessionId");
  const event = searchParams.get("event") ?? "";
  const countedOnly = searchParams.get("counted") === "1";
  const { page, limit, skip } = paginationParams(searchParams, {
    defaultLimit: 50,
    maxLimit: 200,
  });

  const where: Record<string, unknown> = {};
  if (userId) where.userId = userId;
  if (sessionId) where.sessionId = sessionId;
  if (VALID_EVENTS.includes(event)) where.event = event;
  if (countedOnly) where.counted = true;

  const [events, total, byEvent] = await Promise.all([
    prisma.proctorEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        session: {
          select: {
            id: true,
            candidateName: true,
            candidateEmail: true,
            state: true,
            assessment: { select: { id: true, title: true } },
          },
        },
      },
    }),
    prisma.proctorEvent.count({ where }),
    // Counts for the whole log, not this page — the filter bar has to say how
    // much there is of each kind before you pick one.
    prisma.proctorEvent.groupBy({ by: ["event"], _count: { _all: true } }),
  ]);

  // Events raised outside a proctored run — practice on the open problem pages —
  // have no session to read a name from, so fall back to the account.
  const orphanIds = Array.from(
    new Set(events.filter((e) => !e.session).map((e) => e.userId))
  );
  const users = orphanIds.length
    ? await prisma.user.findMany({
        where: { id: { in: orphanIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    events: events.map((e) => {
      const fallback = userById.get(e.userId);
      return {
        id: e.id,
        userId: e.userId,
        attemptId: e.attemptId,
        sessionId: e.sessionId,
        event: e.event,
        detail: e.detail,
        counted: e.counted,
        createdAt: e.createdAt,
        candidateName: e.session?.candidateName ?? fallback?.name ?? null,
        candidateEmail: e.session?.candidateEmail ?? fallback?.email ?? null,
        assessmentId: e.session?.assessment.id ?? null,
        assessmentTitle: e.session?.assessment.title ?? null,
      };
    }),
    counts: Object.fromEntries(byEvent.map((r) => [r.event, r._count._all])),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}
