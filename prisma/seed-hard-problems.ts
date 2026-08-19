import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Case = { ordinal: number; kind: string; stdin: string; expectedOutput: string };

const testcases: Record<string, Case[]> = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "prisma", "hard-problems-testcases.json"), "utf8")
);

const ALLOWED_LANGUAGES = "50,54,62,63,71,73,74"; // C, C++17, Java, Node, Python3, Rust, TS

const problems = [
  {
    slug: "trapping-rain-water",
    title: "Trapping Rain Water",
    description: `## Trapping Rain Water

You are given \`n\` non-negative integers representing an elevation map where the width of each bar is 1. Compute how much water it can trap after raining.

### Input
- Line 1: integer \`n\` — the number of bars.
- Line 2: \`n\` space-separated non-negative integers, the height of each bar (blank if \`n = 0\`).

### Output
Print a single integer — the total units of water trapped.

### Constraints
- 0 ≤ n ≤ 2 × 10^4
- 0 ≤ height[i] ≤ 10^5

### Example
**Input:**
\`\`\`
12
0 1 0 2 1 0 1 3 2 1 2 1
\`\`\`
**Output:** \`6\`
`,
    starterCode: {
      "71": `import sys

def main():
    data = sys.stdin.read().split('\\n')
    n = int(data[0].strip())
    heights = list(map(int, data[1].split())) if n > 0 else []
    # Your code here — compute the total trapped water
    print(0)

main()
`,
      "63": `const lines = require('fs').readFileSync('/dev/stdin', 'utf8').split('\\n');
const n = parseInt(lines[0], 10);
const heights = n > 0 ? lines[1].trim().split(/\\s+/).map(Number) : [];
// Your code here — compute the total trapped water
console.log(0);
`,
    },
  },
  {
    slug: "largest-rectangle-histogram",
    title: "Largest Rectangle in Histogram",
    description: `## Largest Rectangle in Histogram

Given \`n\` integers representing the heights of histogram bars (each of width 1, standing side by side), find the area of the largest rectangle that fits entirely within the histogram.

### Input
- Line 1: integer \`n\` — the number of bars.
- Line 2: \`n\` space-separated non-negative integers, the height of each bar (blank if \`n = 0\`).

### Output
Print a single integer — the maximum rectangular area.

### Constraints
- 0 ≤ n ≤ 10^5
- 0 ≤ height[i] ≤ 10^4

### Example
**Input:**
\`\`\`
6
2 1 5 6 2 3
\`\`\`
**Output:** \`10\`
`,
    starterCode: {
      "71": `import sys

def main():
    data = sys.stdin.read().split('\\n')
    n = int(data[0].strip())
    heights = list(map(int, data[1].split())) if n > 0 else []
    # Your code here — compute the largest rectangle area
    print(0)

main()
`,
      "63": `const lines = require('fs').readFileSync('/dev/stdin', 'utf8').split('\\n');
const n = parseInt(lines[0], 10);
const heights = n > 0 ? lines[1].trim().split(/\\s+/).map(Number) : [];
// Your code here — compute the largest rectangle area
console.log(0);
`,
    },
  },
  {
    slug: "sliding-window-maximum",
    title: "Sliding Window Maximum",
    description: `## Sliding Window Maximum

Given \`n\` integers and a window size \`k\`, return the maximum value in each contiguous window of size \`k\` as it slides from left to right across the array.

### Input
- Line 1: two space-separated integers \`n\` and \`k\` (1 ≤ k ≤ n).
- Line 2: \`n\` space-separated integers.

### Output
Print the \`n - k + 1\` window maximums, space-separated, on one line.

### Constraints
- 1 ≤ n ≤ 10^5
- 1 ≤ k ≤ n
- -10^4 ≤ nums[i] ≤ 10^4

### Example
**Input:**
\`\`\`
8 3
1 3 -1 -3 5 3 6 7
\`\`\`
**Output:** \`3 3 5 5 6 7\`
`,
    starterCode: {
      "71": `import sys

def main():
    data = sys.stdin.read().split('\\n')
    n, k = map(int, data[0].split())
    nums = list(map(int, data[1].split()))
    # Your code here — compute the max of every window of size k
    print()

main()
`,
      "63": `const lines = require('fs').readFileSync('/dev/stdin', 'utf8').split('\\n');
const [n, k] = lines[0].trim().split(/\\s+/).map(Number);
const nums = lines[1].trim().split(/\\s+/).map(Number);
// Your code here — compute the max of every window of size k
console.log('');
`,
    },
  },
  {
    slug: "merge-k-sorted-lists",
    title: "Merge k Sorted Lists",
    description: `## Merge k Sorted Lists

You are given \`k\` lists, each already sorted in ascending order. Merge all of them into a single sorted sequence.

### Input
- Line 1: integer \`k\` — the number of lists.
- Next \`k\` lines: each starts with \`m\` (the length of that list) followed by \`m\` sorted integers. If \`m = 0\`, no integers follow on that line.

### Output
Print the fully merged, ascending sequence of all elements, space-separated on one line (print an empty line if every list is empty).

### Constraints
- 0 ≤ k ≤ 10^4
- 0 ≤ m ≤ 500 per list
- -10^4 ≤ value ≤ 10^4

### Example
**Input:**
\`\`\`
3
3 1 4 5
3 1 3 4
2 2 6
\`\`\`
**Output:** \`1 1 2 3 4 4 5 6\`
`,
    starterCode: {
      "71": `import sys

def main():
    data = sys.stdin.read().split('\\n')
    k = int(data[0].strip())
    lists = []
    idx = 1
    for _ in range(k):
        parts = list(map(int, data[idx].split()))
        idx += 1
        m = parts[0]
        lists.append(parts[1:1 + m])
    # Your code here — merge all k sorted lists into one sorted sequence
    print()

main()
`,
      "63": `const lines = require('fs').readFileSync('/dev/stdin', 'utf8').split('\\n');
const k = parseInt(lines[0], 10);
const lists = [];
for (let i = 0; i < k; i++) {
  const parts = lines[1 + i].trim().split(/\\s+/).map(Number);
  const m = parts[0];
  lists.push(parts.slice(1, 1 + m));
}
// Your code here — merge all k sorted lists into one sorted sequence
console.log('');
`,
    },
  },
];

async function main() {
  for (const p of problems) {
    const cases = testcases[p.slug];
    if (!cases) throw new Error(`No test cases found for ${p.slug}`);

    await prisma.problem.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        title: p.title,
        slug: p.slug,
        description: p.description,
        difficulty: "hard",
        allowedLanguages: ALLOWED_LANGUAGES,
        timeLimitMs: 3000,
        memoryLimitKb: 128000,
        starterCode: JSON.stringify(p.starterCode),
        testCases: {
          create: cases.map((c) => ({
            ordinal: c.ordinal,
            kind: c.kind,
            stdin: c.stdin,
            expectedOutput: c.expectedOutput,
            weight: c.kind === "sample" ? 1 : 2,
          })),
        },
      },
    });

    console.log(`Upserted: ${p.title} (${cases.length} test cases)`);
  }

  console.log("Done — 4 hard problems added.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
