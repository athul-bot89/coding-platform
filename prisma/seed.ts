import { randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Create a sample problem
  const problem = await prisma.problem.upsert({
    where: { slug: "two-sum" },
    update: {},
    create: {
      title: "Two Sum",
      slug: "two-sum",
      description: `## Two Sum

Given two integers separated by a space, print their sum.

### Input
A single line containing two space-separated integers a and b.

### Output
Print the sum of a and b.

### Constraints
- -10^9 ≤ a, b ≤ 10^9

### Example
**Input:** \`3 4\`  
**Output:** \`7\`
`,
      difficulty: "easy",
      allowedLanguages: "50,54,62,63,71,73,74",
      timeLimitMs: 2000,
      memoryLimitKb: 128000,
      starterCode: JSON.stringify({
        "71": "# Read two integers and print their sum\na, b = map(int, input().split())\nprint(a + b)",
        "63": "// Read two integers and print their sum\nconst readline = require('readline');\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const [a, b] = line.split(' ').map(Number);\n  console.log(a + b);\n  rl.close();\n});",
        "54": "#include <iostream>\nusing namespace std;\nint main() {\n    int a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}",
        "62": "import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int a = sc.nextInt();\n        int b = sc.nextInt();\n        System.out.println(a + b);\n    }\n}",
      }),
      testCases: {
        create: [
          { ordinal: 1, kind: "sample", stdin: "3 4", expectedOutput: "7", weight: 1 },
          { ordinal: 2, kind: "sample", stdin: "10 20", expectedOutput: "30", weight: 1 },
          { ordinal: 3, kind: "hidden", stdin: "-5 5", expectedOutput: "0", weight: 1 },
          { ordinal: 4, kind: "hidden", stdin: "1000000000 999999999", expectedOutput: "1999999999", weight: 1 },
          { ordinal: 5, kind: "hidden", stdin: "0 0", expectedOutput: "0", weight: 1 },
        ],
      },
    },
  });

  const problem2 = await prisma.problem.upsert({
    where: { slug: "fizzbuzz" },
    update: {},
    create: {
      title: "FizzBuzz",
      slug: "fizzbuzz",
      description: `## FizzBuzz

Given an integer N, print numbers from 1 to N. But for multiples of 3 print "Fizz", for multiples of 5 print "Buzz", and for multiples of both 3 and 5 print "FizzBuzz".

### Input
A single integer N.

### Output
Print N lines, each containing either the number, "Fizz", "Buzz", or "FizzBuzz".

### Example
**Input:** \`5\`  
**Output:**
\`\`\`
1
2
Fizz
4
Buzz
\`\`\`
`,
      difficulty: "easy",
      allowedLanguages: "50,54,62,63,71,73,74",
      timeLimitMs: 2000,
      memoryLimitKb: 128000,
      starterCode: JSON.stringify({
        "71": "n = int(input())\nfor i in range(1, n + 1):\n    # Your code here\n    pass",
        "63": "const readline = require('readline');\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on('line', (line) => {\n  const n = parseInt(line);\n  // Your code here\n  rl.close();\n});",
      }),
      testCases: {
        create: [
          { ordinal: 1, kind: "sample", stdin: "5", expectedOutput: "1\n2\nFizz\n4\nBuzz", weight: 1 },
          { ordinal: 2, kind: "hidden", stdin: "15", expectedOutput: "1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz", weight: 2 },
          { ordinal: 3, kind: "hidden", stdin: "1", expectedOutput: "1", weight: 1 },
        ],
      },
    },
  });

  // A ready-to-use proctored test so the shared-link flow can be exercised
  // immediately. Its link is printed below.
  const existing = await prisma.assessment.findFirst({
    where: { title: "Sample Screening Test" },
  });

  const assessment =
    existing ??
    (await prisma.assessment.create({
      data: {
        title: "Sample Screening Test",
        instructions:
          "Solve both questions. You may submit as often as you like — your best submission for each question counts.",
        durationMinutes: 45,
        // Mirrors DEFAULT_MAX_VIOLATIONS in src/lib/proctor-config.ts — inlined
        // because the seed runs under bare ts-node, which does not resolve "@/".
        maxViolations: 5,
        joinToken: randomBytes(16).toString("hex"),
      },
    }));

  await prisma.assessmentProblem.deleteMany({ where: { assessmentId: assessment.id } });
  await prisma.assessmentProblem.createMany({
    data: [
      { assessmentId: assessment.id, problemId: problem.id, ordinal: 1, points: 40 },
      { assessmentId: assessment.id, problemId: problem2.id, ordinal: 2, points: 60 },
    ],
  });

  console.log("Seed completed!");
  console.log("Problems created:", problem.title, problem2.title);
  console.log(`Assessment ready: "${assessment.title}" (${assessment.durationMinutes} min)`);
  console.log(
    `Shared test link: ${(process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000").replace(
      /\/$/,
      ""
    )}/t/${assessment.joinToken}`
  );
  console.log("Next: sign in, set your User.role to 'admin', then open /admin/assessments");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
