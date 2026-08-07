import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, paginationParams } from "@/lib/admin-guard";
import { LANGUAGE_NAMES } from "@/lib/languages";

const validLanguageIds = new Set(Object.keys(LANGUAGE_NAMES).map(Number));

/** GET  /api/admin/problems — list all problems with test-case counts */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { skip, take, page } = paginationParams(req.nextUrl.searchParams, {
    defaultLimit: 50,
  });

  const [problems, total] = await Promise.all([
    prisma.problem.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        _count: { select: { testCases: true, attempts: true } },
        testCases: {
          select: { id: true, kind: true, weight: true },
        },
      },
    }),
    prisma.problem.count(),
  ]);

  return NextResponse.json({
    problems: problems.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      difficulty: p.difficulty,
      isActive: p.isActive,
      allowedLanguages: p.allowedLanguages,
      timeLimitMs: p.timeLimitMs,
      memoryLimitKb: p.memoryLimitKb,
      createdAt: p.createdAt,
      testCaseCount: p._count.testCases,
      attemptCount: p._count.attempts,
      sampleCount: p.testCases.filter((t) => t.kind === "sample").length,
      hiddenCount: p.testCases.filter((t) => t.kind === "hidden").length,
      maxScore: p.testCases.reduce((s, t) => s + t.weight, 0),
    })),
    page,
    totalPages: Math.ceil(total / take),
    total,
  });
}

/** POST /api/admin/problems — create a new problem */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const body = await req.json().catch(() => ({}));
  const err = validateProblemBody(body);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const {
    title,
    slug,
    description,
    difficulty,
    allowedLanguages,
    timeLimitMs,
    memoryLimitKb,
    starterCode,
    isActive,
    testCases,
  } = body;

  // Check slug uniqueness
  const existing = await prisma.problem.findUnique({ where: { slug: slug.trim() } });
  if (existing) {
    return NextResponse.json(
      { error: `A problem with slug "${slug.trim()}" already exists` },
      { status: 409 }
    );
  }

  const problem = await prisma.problem.create({
    data: {
      title: title.trim(),
      slug: slug.trim(),
      description: description.trim(),
      difficulty,
      allowedLanguages: allowedLanguages.join(","),
      timeLimitMs: Math.floor(timeLimitMs),
      memoryLimitKb: Math.floor(memoryLimitKb),
      starterCode: starterCode ? JSON.stringify(starterCode) : null,
      isActive: isActive ?? true,
      testCases: {
        create: testCases.map(
          (tc: any, i: number) => ({
            ordinal: i + 1,
            kind: tc.kind,
            stdin: tc.stdin,
            expectedOutput: tc.expectedOutput,
            weight: tc.weight ?? 1,
          })
        ),
      },
    },
    include: { testCases: { orderBy: { ordinal: "asc" } } },
  });

  return NextResponse.json({ id: problem.id, slug: problem.slug }, { status: 201 });
}

// ── validation ──────────────────────────────────────────────────────────────

function validateProblemBody(body: any): string | null {
  if (typeof body.title !== "string" || !body.title.trim()) return "Title is required";
  if (typeof body.slug !== "string" || !body.slug.trim()) return "Slug is required";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug.trim()))
    return "Slug must be lowercase alphanumeric with hyphens (e.g. two-sum)";
  if (typeof body.description !== "string" || !body.description.trim())
    return "Description is required";
  if (!["easy", "medium", "hard"].includes(body.difficulty))
    return "Difficulty must be easy, medium, or hard";

  if (!Array.isArray(body.allowedLanguages) || body.allowedLanguages.length === 0)
    return "At least one language must be allowed";
  for (const id of body.allowedLanguages) {
    if (!validLanguageIds.has(Number(id)))
      return `Invalid language ID: ${id}`;
  }

  const tl = Number(body.timeLimitMs);
  if (!Number.isFinite(tl) || tl < 500 || tl > 30000)
    return "Time limit must be 500–30000 ms";

  const ml = Number(body.memoryLimitKb);
  if (!Number.isFinite(ml) || ml < 1024 || ml > 512000)
    return "Memory limit must be 1024–512000 KB";

  if (body.starterCode != null && typeof body.starterCode !== "object")
    return "Starter code must be a JSON object mapping language IDs to code";

  if (!Array.isArray(body.testCases) || body.testCases.length === 0)
    return "At least one test case is required";

  for (let i = 0; i < body.testCases.length; i++) {
    const tc = body.testCases[i];
    if (typeof tc.stdin !== "string") return `Test case ${i + 1}: stdin is required`;
    if (typeof tc.expectedOutput !== "string")
      return `Test case ${i + 1}: expectedOutput is required`;
    if (!["sample", "hidden"].includes(tc.kind))
      return `Test case ${i + 1}: kind must be "sample" or "hidden"`;
    if (tc.weight != null) {
      const w = Number(tc.weight);
      if (!Number.isInteger(w) || w < 1 || w > 100)
        return `Test case ${i + 1}: weight must be 1–100`;
    }
  }

  return null;
}
