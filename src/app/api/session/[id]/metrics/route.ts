import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";

const MAX_BURSTS = 100;

/**
 * Accumulate code-integrity signals for one problem.
 *
 * The client sends deltas since the last flush; the server only ever adds. This
 * catches code that arrived faster than it could have been typed, which covers
 * transcription from a phone or second machine — cases where the clipboard was
 * never involved and nothing else would notice.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = await req.json().catch(() => ({}));
  const { problemId } = body;

  if (!problemId) {
    return NextResponse.json({ error: "Missing problemId" }, { status: 400 });
  }
  if (!session.invitation.assessment.problems.some((p) => p.problemId === problemId)) {
    return NextResponse.json({ error: "Problem not in this test" }, { status: 400 });
  }

  const keystrokes = clampInt(body.keystrokes);
  const charsTyped = clampInt(body.charsTyped);
  const activeMs = clampInt(body.activeMs);
  const largestInsertion = clampInt(body.largestInsertion);
  const newBursts: { atMs: number; chars: number }[] = Array.isArray(body.bursts)
    ? body.bursts
        .slice(0, MAX_BURSTS)
        .map((b: any) => ({ atMs: clampInt(b?.atMs), chars: clampInt(b?.chars) }))
    : [];

  const existing = await prisma.typingMetric.findUnique({
    where: { sessionId_problemId: { sessionId: session.id, problemId } },
  });

  const merged = [
    ...(existing?.bursts ? safeParse(existing.bursts) : []),
    ...newBursts,
  ].slice(-MAX_BURSTS);

  await prisma.typingMetric.upsert({
    where: { sessionId_problemId: { sessionId: session.id, problemId } },
    create: {
      sessionId: session.id,
      problemId,
      keystrokes,
      charsTyped,
      activeMs,
      largestInsertion,
      burstCount: newBursts.length,
      bursts: JSON.stringify(merged),
    },
    update: {
      keystrokes: { increment: keystrokes },
      charsTyped: { increment: charsTyped },
      activeMs: { increment: activeMs },
      burstCount: { increment: newBursts.length },
      largestInsertion: Math.max(existing?.largestInsertion ?? 0, largestInsertion),
      bursts: JSON.stringify(merged),
    },
  });

  return NextResponse.json({ ok: true });
}

function clampInt(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 10_000_000);
}

function safeParse(s: string): { atMs: number; chars: number }[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
