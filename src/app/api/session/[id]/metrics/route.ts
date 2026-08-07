import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";

/**
 * How many individual insertions are retained per problem.
 *
 * `burstCount` and `largestInsertion` describe the whole session exactly; the
 * stored list is only the most recent insertions, which is what the report says
 * it is. An exact total of burst characters cannot survive that truncation
 * without a `burstChars` counter column on TypingMetric — the column is the one
 * thing missing, since the JSON shape is read back by the admin report and
 * cannot carry a summary of its own.
 */
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
  const { session, problems } = guard;

  const body = await req.json().catch(() => ({}));
  const { problemId } = body;

  if (!problemId) {
    return NextResponse.json({ error: "Missing problemId" }, { status: 400 });
  }
  // The session's frozen problem set, not the assessment's current one: dropping
  // a question from the assessment mid-test must not start rejecting the flushes
  // of a candidate who is still answering it.
  if (!problems.some((p) => p.problemId === problemId)) {
    return NextResponse.json({ error: "Problem not in this test" }, { status: 400 });
  }

  const keystrokes = clampInt(body.keystrokes);
  const charsTyped = clampInt(body.charsTyped);
  const activeMs = clampInt(body.activeMs);

  // An insertion of no characters is noise rather than evidence, and counting it
  // would inflate burstCount, which the report presents as an exact figure.
  const newBursts: { atMs: number; chars: number }[] = Array.isArray(body.bursts)
    ? body.bursts
        .map((b: any) => ({ atMs: clampInt(b?.atMs), chars: clampInt(b?.chars) }))
        .filter((b: { chars: number }) => b.chars > 0)
    : [];

  // A burst the client recorded is evidence in its own right, so take whichever
  // of the two the client sent is larger. A disagreement can then only raise the
  // signal, never hide a paste behind a zeroed field.
  const largestInsertion = newBursts.reduce(
    (max, b) => Math.max(max, b.chars),
    clampInt(body.largestInsertion)
  );

  // Both the maximum and the burst list fold new data into the stored value, so
  // reading them outside the write loses data: the client flushes on a timer, on
  // question switch, on submit and on finish, so two flushes for one problem
  // overlap routinely, and each would write a merge that ignores the other —
  // dropping bursts and lowering the maximum. Reading inside the transaction
  // that writes serializes the two. A flush rejected because of that
  // serialization is no loss either: the client merges the unsent window back
  // and the next flush carries it.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.typingMetric.findUnique({
      where: { sessionId_problemId: { sessionId: session.id, problemId } },
    });

    // Keep the tail, so what survives is the most recent insertions.
    const merged = [
      ...(existing?.bursts ? safeParse(existing.bursts) : []),
      ...newBursts,
    ].slice(-MAX_BURSTS);

    await tx.typingMetric.upsert({
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
