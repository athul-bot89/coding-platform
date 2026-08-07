import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-guard";
import { LANGUAGE_NAMES } from "@/lib/languages";

const validLanguageIds = new Set(Object.keys(LANGUAGE_NAMES).map(Number));

/** GET /api/admin/problems/[id] — full problem + test cases */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { id } = await params;
  const problem = await prisma.problem.findUnique({
    where: { id },
    include: { testCases: { orderBy: { ordinal: "asc" } } },
  });
  if (!problem) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...problem,
    allowedLanguages: problem.allowedLanguages.split(",").map(Number),
    starterCode: problem.starterCode ? JSON.parse(problem.starterCode) : {},
  });
}

/** PATCH /api/admin/problems/[id] — update problem fields + test cases */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { id } = await params;
  const existing = await prisma.problem.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));

  // Build the partial update data
  const data: any = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim())
      return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    data.title = body.title.trim();
  }

  if (body.slug !== undefined) {
    if (typeof body.slug !== "string" || !body.slug.trim())
      return NextResponse.json({ error: "Slug cannot be empty" }, { status: 400 });
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug.trim()))
      return NextResponse.json(
        { error: "Slug must be lowercase alphanumeric with hyphens" },
        { status: 400 }
      );
    if (body.slug.trim() !== existing.slug) {
      const conflict = await prisma.problem.findUnique({
        where: { slug: body.slug.trim() },
      });
      if (conflict)
        return NextResponse.json(
          { error: `Slug "${body.slug.trim()}" is already taken` },
          { status: 409 }
        );
    }
    data.slug = body.slug.trim();
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || !body.description.trim())
      return NextResponse.json({ error: "Description cannot be empty" }, { status: 400 });
    data.description = body.description.trim();
  }

  if (body.difficulty !== undefined) {
    if (!["easy", "medium", "hard"].includes(body.difficulty))
      return NextResponse.json(
        { error: "Difficulty must be easy, medium, or hard" },
        { status: 400 }
      );
    data.difficulty = body.difficulty;
  }

  if (body.allowedLanguages !== undefined) {
    if (!Array.isArray(body.allowedLanguages) || body.allowedLanguages.length === 0)
      return NextResponse.json(
        { error: "At least one language must be allowed" },
        { status: 400 }
      );
    for (const lid of body.allowedLanguages) {
      if (!validLanguageIds.has(Number(lid)))
        return NextResponse.json({ error: `Invalid language ID: ${lid}` }, { status: 400 });
    }
    data.allowedLanguages = body.allowedLanguages.join(",");
  }

  if (body.timeLimitMs !== undefined) {
    const tl = Number(body.timeLimitMs);
    if (!Number.isFinite(tl) || tl < 500 || tl > 30000)
      return NextResponse.json(
        { error: "Time limit must be 500–30000 ms" },
        { status: 400 }
      );
    data.timeLimitMs = Math.floor(tl);
  }

  if (body.memoryLimitKb !== undefined) {
    const ml = Number(body.memoryLimitKb);
    if (!Number.isFinite(ml) || ml < 1024 || ml > 512000)
      return NextResponse.json(
        { error: "Memory limit must be 1024–512000 KB" },
        { status: 400 }
      );
    data.memoryLimitKb = Math.floor(ml);
  }

  if (body.starterCode !== undefined) {
    data.starterCode =
      body.starterCode && typeof body.starterCode === "object"
        ? JSON.stringify(body.starterCode)
        : null;
  }

  if (body.isActive !== undefined) {
    data.isActive = !!body.isActive;
  }

  // Replace test cases if provided
  if (body.testCases !== undefined) {
    if (!Array.isArray(body.testCases) || body.testCases.length === 0)
      return NextResponse.json(
        { error: "At least one test case is required" },
        { status: 400 }
      );

    for (let i = 0; i < body.testCases.length; i++) {
      const tc = body.testCases[i];
      if (typeof tc.stdin !== "string")
        return NextResponse.json(
          { error: `Test case ${i + 1}: stdin is required` },
          { status: 400 }
        );
      if (typeof tc.expectedOutput !== "string")
        return NextResponse.json(
          { error: `Test case ${i + 1}: expectedOutput is required` },
          { status: 400 }
        );
      if (!["sample", "hidden"].includes(tc.kind))
        return NextResponse.json(
          { error: `Test case ${i + 1}: kind must be "sample" or "hidden"` },
          { status: 400 }
        );
    }

    // Delete old test cases and create new ones atomically
    await prisma.$transaction([
      prisma.testCase.deleteMany({ where: { problemId: id } }),
      ...body.testCases.map((tc: any, i: number) =>
        prisma.testCase.create({
          data: {
            problemId: id,
            ordinal: i + 1,
            kind: tc.kind,
            stdin: tc.stdin,
            expectedOutput: tc.expectedOutput,
            weight: Math.max(1, Math.floor(Number(tc.weight) || 1)),
          },
        })
      ),
    ]);
  }

  const updated = await prisma.problem.update({
    where: { id },
    data,
    include: { testCases: { orderBy: { ordinal: "asc" } } },
  });

  return NextResponse.json({
    ...updated,
    allowedLanguages: updated.allowedLanguages.split(",").map(Number),
    starterCode: updated.starterCode ? JSON.parse(updated.starterCode) : {},
  });
}

/** DELETE /api/admin/problems/[id] — soft-delete (deactivate) or hard-delete */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { id } = await params;
  const hard = req.nextUrl.searchParams.get("hard") === "true";

  const problem = await prisma.problem.findUnique({
    where: { id },
    include: { _count: { select: { attempts: true } } },
  });
  if (!problem) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (hard) {
    if (problem._count.attempts > 0) {
      return NextResponse.json(
        { error: "Cannot hard-delete a problem with existing attempts. Deactivate it instead." },
        { status: 409 }
      );
    }
    await prisma.problem.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  }

  // Soft-delete: toggle isActive
  const updated = await prisma.problem.update({
    where: { id },
    data: { isActive: !problem.isActive },
  });

  return NextResponse.json({ id: updated.id, isActive: updated.isActive });
}
