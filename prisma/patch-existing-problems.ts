// Closes two verified coverage gaps in the pre-existing beginner problems, and
// restores the technique instruction each question was originally written around.
//
// Usage:
//   npx ts-node prisma/patch-existing-problems.ts            # dry run
//   npx ts-node prisma/patch-existing-problems.ts --commit   # writes
//
// Both changes are ADDITIVE on purpose:
//
//   * A new TestCase is appended. Nothing is deleted, so no AttemptRun rows
//     cascade away and the per-case history of past submissions survives intact.
//     Session scoring reads each attempt's own score/maxScore ratio (see
//     computeSessionScore in src/lib/assessment.ts), so attempts graded against
//     8 cases stay directly comparable to ones graded against 9.
//
//   * The description gains one Constraints bullet. Judge0 only compares stdout,
//     so a technique restriction is candidate guidance and a manual-review cue,
//     never machine-enforced.
//
// Why these two cases specifically — each was confirmed on Judge0 to be the sole
// discriminator against a wrong solution that scored full marks on the old set:
//
//   largest-of-three  "-5 -1 -1" -> "-1"
//     No existing case had b == c as the strict maximum, so the common
//     if/elif/elif chain with no final else returned None and still scored 8/8.
//
//   reverse-a-string  100-character input
//     The longest existing input was 36 characters against a stated limit of
//     100, so a solution using a fixed 40-character buffer scored 8/8.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");

type Patch = {
  slug: string;
  /** Appended verbatim as the last "### Constraints" bullet. */
  constraintBullet: string;
  newCase: { kind: string; stdin: string; expectedOutput: string; weight: number };
};

const PATCHES: Patch[] = [
  {
    slug: "largest-of-three",
    constraintBullet:
      "- Write a separate function that takes the three numbers as parameters and returns the largest, then call it from your program.",
    newCase: { kind: "hidden", stdin: "-5 -1 -1", expectedOutput: "-1", weight: 1 },
  },
  {
    slug: "reverse-a-string",
    constraintBullet:
      "- Solve this without using string slicing (`[::-1]`) or a built-in reverse helper such as `reversed()`, `StringBuilder.reverse()` or `std::reverse` — build the reversed string with an explicit loop.",
    newCase: {
      kind: "hidden",
      stdin:
        "Az9By8Cx7Dw6Ev5Az9By8Cx7Dw6Ev5Az9By8Cx7Dw6Ev5Az9By8Cx7Dw6Ev5Az9By8Cx7Dw6Ev5Az9By8Cx7Dw6Ev5Az9By8Cx7D",
      expectedOutput:
        "D7xC8yB9zA5vE6wD7xC8yB9zA5vE6wD7xC8yB9zA5vE6wD7xC8yB9zA5vE6wD7xC8yB9zA5vE6wD7xC8yB9zA5vE6wD7xC8yB9zA",
      weight: 1,
    },
  },
];

/** Append a bullet to the end of the "### Constraints" block, once. */
function addConstraintBullet(description: string, bullet: string): { text: string; changed: boolean } {
  if (description.includes(bullet)) return { text: description, changed: false };

  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### Constraints");
  if (start === -1) throw new Error("no '### Constraints' section to append to");

  // The block runs to the next heading, or to the end of the description.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### ") || lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Insert after the last non-blank line of the block so the blank line that
  // separates it from the next heading is preserved.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;

  lines.splice(insertAt, 0, bullet);
  return { text: lines.join("\n"), changed: true };
}

async function main() {
  console.log(commit ? "=== COMMIT ===" : "=== DRY RUN (pass --commit to write) ===");

  for (const patch of PATCHES) {
    const problem = await prisma.problem.findUnique({
      where: { slug: patch.slug },
      include: { testCases: { orderBy: { ordinal: "asc" } } },
    });
    if (!problem) {
      console.log(`\nMISSING ${patch.slug} — skipped`);
      continue;
    }

    console.log(`\n[${patch.slug}]`);

    // --- description ---
    const { text, changed } = addConstraintBullet(problem.description, patch.constraintBullet);
    if (!changed) {
      console.log("  description: bullet already present, no change");
    } else {
      console.log(`  description: append bullet -> ${patch.constraintBullet.slice(0, 72)}...`);
    }

    // --- test case ---
    const already = problem.testCases.find((c) => c.stdin === patch.newCase.stdin);
    const nextOrdinal = Math.max(0, ...problem.testCases.map((c) => c.ordinal)) + 1;
    if (already) {
      console.log(`  test case: stdin already present as #${already.ordinal}, no change`);
    } else {
      const visible = problem.testCases.filter((c) => c.kind === "sample").length;
      const hidden = problem.testCases.filter((c) => c.kind === "hidden").length;
      console.log(
        `  test case: append #${nextOrdinal} (${patch.newCase.kind}) — ` +
          `${visible} visible + ${hidden} hidden becomes ${visible} visible + ${hidden + 1} hidden`
      );
    }

    if (!commit) continue;

    await prisma.$transaction(async (tx) => {
      if (changed) {
        await tx.problem.update({ where: { id: problem.id }, data: { description: text } });
      }
      if (!already) {
        await tx.testCase.create({
          data: {
            problemId: problem.id,
            ordinal: nextOrdinal,
            kind: patch.newCase.kind,
            stdin: patch.newCase.stdin,
            expectedOutput: patch.newCase.expectedOutput,
            weight: patch.newCase.weight,
          },
        });
      }
    });
    console.log("  written");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
