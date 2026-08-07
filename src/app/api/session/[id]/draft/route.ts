import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireLiveSession } from "@/lib/session-guard";

// Autosave editor content so a refresh, crash or accidental close loses nothing.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireLiveSession(params.id);
  if (guard.error) return guard.error;
  const { session, problems } = guard;

  const { problemId, languageId, code } = await req.json().catch(() => ({}));

  if (!problemId || typeof code !== "string" || !languageId) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  // Checked against the session's frozen problem set rather than the
  // assessment's current one, so an admin removing a question mid-test cannot
  // start silently discarding the autosaves of a candidate still working on it.
  const belongs = problems.some((p) => p.problemId === problemId);
  if (!belongs) {
    return NextResponse.json({ error: "Problem not in this test" }, { status: 400 });
  }

  await prisma.sessionDraft.upsert({
    where: { sessionId_problemId: { sessionId: session.id, problemId } },
    create: { sessionId: session.id, problemId, languageId, code },
    update: { languageId, code },
  });

  return NextResponse.json({ ok: true });
}
