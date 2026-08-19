// Seeds the beginner/moderate "programming basics" question set.
//
// Problem text, starter code and test cases live in programming-basics.json
// alongside the reference and deliberately-wrong solutions each question was
// verified against, so the whole set can be re-checked against Judge0 later
// without reconstructing it by hand.
//
// Usage:
//   npx ts-node prisma/seed-programming-basics.ts            # dry run, prints the plan
//   npx ts-node prisma/seed-programming-basics.ts --commit   # writes
//
// Inserting is create-only by design. Updating a Problem's test cases would
// cascade-delete every AttemptRun that references them (see the onDelete on
// TestCase.problem in schema.prisma), silently destroying the per-case detail of
// past candidate submissions — so a slug that already exists is reported and
// skipped rather than rewritten.
import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Case = { ordinal: number; kind: string; stdin: string; expectedOutput: string; weight?: number };
type Spec = {
  slug: string;
  title: string;
  difficulty: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  allowedLanguages: string;
  description: string;
  starterCode: Record<string, string>;
  cases: Case[];
};

const commit = process.argv.includes("--commit");

const specs: Spec[] = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "prisma", "programming-basics.json"), "utf8")
);

async function main() {
  console.log(commit ? "=== COMMIT ===" : "=== DRY RUN (pass --commit to write) ===");

  let created = 0;
  let skipped = 0;

  for (const s of specs) {
    const existing = await prisma.problem.findUnique({
      where: { slug: s.slug },
      include: { _count: { select: { testCases: true } } },
    });

    if (existing) {
      skipped++;
      console.log(
        `SKIP   ${s.slug} — already exists (${existing._count.testCases} test cases). ` +
          `Not rewritten: replacing its test cases would cascade-delete past AttemptRun rows.`
      );
      continue;
    }

    const samples = s.cases.filter((c) => c.kind === "sample").length;
    const hidden = s.cases.filter((c) => c.kind === "hidden").length;

    if (!commit) {
      created++;
      console.log(
        `CREATE ${s.slug} — "${s.title}" [${s.difficulty}] ${samples} visible + ${hidden} hidden, ` +
          `${Object.keys(s.starterCode).length} starter languages`
      );
      continue;
    }

    await prisma.problem.create({
      data: {
        title: s.title,
        slug: s.slug,
        description: s.description,
        difficulty: s.difficulty,
        allowedLanguages: s.allowedLanguages,
        timeLimitMs: s.timeLimitMs,
        memoryLimitKb: s.memoryLimitKb,
        starterCode: JSON.stringify(s.starterCode),
        testCases: {
          create: s.cases.map((c) => ({
            ordinal: c.ordinal,
            kind: c.kind,
            stdin: c.stdin,
            expectedOutput: c.expectedOutput,
            weight: c.weight ?? 1,
          })),
        },
      },
    });

    created++;
    console.log(`CREATE ${s.slug} — "${s.title}" [${s.difficulty}] ${samples} visible + ${hidden} hidden`);
  }

  console.log(
    `\n${commit ? "Created" : "Would create"} ${created}, skipped ${skipped}, of ${specs.length} specs.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
