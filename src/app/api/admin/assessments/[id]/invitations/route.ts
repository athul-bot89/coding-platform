import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { generateInviteToken, inviteUrl, defaultInviteExpiry } from "@/lib/assessment";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Mint one invite link per candidate.
 *
 * Links are returned for the admin to copy — this deployment sends no email.
 *
 * A candidate gets at most one link per assessment: a second link would be a
 * second session with its own full-duration clock on the same questions. Repeats
 * — whether they are duplicated inside one paste or already in the database from
 * an earlier click of Generate — come back in `skipped` instead of failing the
 * whole batch, so the admin still gets links for everyone else.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { candidates, validDays } = await req.json().catch(() => ({}));

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return NextResponse.json({ error: "Add at least one candidate" }, { status: 400 });
  }
  if (candidates.length > 200) {
    return NextResponse.json({ error: "Maximum 200 candidates at a time" }, { status: 400 });
  }

  const assessment = await prisma.assessment.findUnique({
    where: { id: params.id },
    include: { problems: true },
  });
  if (!assessment) {
    return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  }
  if (assessment.problems.length === 0) {
    return NextResponse.json(
      { error: "Add at least one question before inviting candidates" },
      { status: 400 }
    );
  }

  const days = Number(validDays);
  const expiresAt = defaultInviteExpiry(
    Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : undefined
  );

  const skipped: { email: string; reason: string }[] = [];

  // Emails are stored trimmed and lowercased, which is also how the unique
  // constraint and `emailsMatch` compare them — casing must not buy a second link.
  const rows: { name: string; email: string }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const email = String(c?.email ?? "").trim().toLowerCase();
    const name = String(c?.name ?? "").trim() || email.split("@")[0];
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: `"${c?.email}" is not a valid email` }, { status: 400 });
    }
    if (seen.has(email)) {
      skipped.push({ email, reason: "Listed more than once" });
      continue;
    }
    seen.add(email);
    rows.push({ name, email });
  }

  const existing = await prisma.invitation.findMany({
    where: { assessmentId: params.id },
    select: { candidateEmail: true },
  });
  const invited = new Set(existing.map((i) => i.candidateEmail.trim().toLowerCase()));

  const created = [];
  for (const row of rows) {
    if (invited.has(row.email)) {
      skipped.push({ email: row.email, reason: "Already invited to this test" });
      continue;
    }

    let invitation;
    try {
      invitation = await prisma.invitation.create({
        data: {
          assessmentId: params.id,
          token: generateInviteToken(),
          candidateName: row.name,
          candidateEmail: row.email,
          expiresAt,
        },
      });
    } catch (err: any) {
      // Two admins generating links at once; the constraint decided who won.
      if (err?.code === "P2002") {
        skipped.push({ email: row.email, reason: "Already invited to this test" });
        continue;
      }
      throw err;
    }

    invited.add(row.email);
    created.push({
      id: invitation.id,
      candidateName: invitation.candidateName,
      candidateEmail: invitation.candidateEmail,
      url: inviteUrl(invitation.token),
      expiresAt: invitation.expiresAt,
    });
  }

  return NextResponse.json({ invitations: created, skipped });
}

/** Revoke an unused link. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const invitationId = new URL(req.url).searchParams.get("invitationId");
  if (!invitationId) {
    return NextResponse.json({ error: "Missing invitationId" }, { status: 400 });
  }

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { session: true },
  });

  if (!invitation || invitation.assessmentId !== params.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (invitation.session) {
    return NextResponse.json(
      { error: "This candidate has already started — revoking would delete their work" },
      { status: 409 }
    );
  }

  await prisma.invitation.delete({ where: { id: invitationId } });
  return NextResponse.json({ ok: true });
}
