#!/usr/bin/env node
// Contract check on authored specs, run before anything touches the database.
// Usage: node .tmp-scripts/validate-specs.mjs <slug> [<slug> ...]

import { readFileSync } from "node:fs";

const REQUIRED_STARTERS = [50, 54, 62, 63, 71, 73, 74];
const REQUIRED_SOLUTIONS = [71, 63, 54, 62];
const ALLOWED = "50,54,62,63,71,73,74";

let failures = 0;
const fail = (slug, msg) => { failures++; console.log(`  FAIL ${slug}: ${msg}`); };

for (const slug of process.argv.slice(2)) {
  const path = `.tmp-scripts/specs/${slug}.json`;
  let s;
  try { s = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { fail(slug, `unreadable/invalid JSON — ${e.message}`); continue; }

  console.log(`\n[${slug}]`);
  // Pre-existing DB problems whose cases are frozen (see the overwrite decision:
  // replacing their cases would cascade-delete historical AttemptRun rows).
  const FROZEN = ["largest-of-three", "reverse-a-string"];
  const frozen = FROZEN.includes(slug);

  if (s.slug !== slug) fail(slug, `spec.slug is "${s.slug}", expected "${slug}"`);
  if (!s.title) fail(slug, "missing title");
  if (!["easy", "medium", "hard"].includes(s.difficulty)) fail(slug, `bad difficulty "${s.difficulty}"`);
  if (s.allowedLanguages !== ALLOWED) fail(slug, `allowedLanguages is "${s.allowedLanguages}", expected "${ALLOWED}"`);
  if (s.timeLimitMs !== 2000) fail(slug, `timeLimitMs is ${s.timeLimitMs}, expected 2000`);
  if (s.memoryLimitKb !== 128000) fail(slug, `memoryLimitKb is ${s.memoryLimitKb}, expected 128000`);

  // description
  if (typeof s.description !== "string" || !s.description.startsWith("## ")) {
    fail(slug, "description must start with '## '");
  } else {
    for (const h of ["### Input", "### Output", "### Constraints", "### Example"]) {
      if (!s.description.includes(h)) fail(slug, `description missing "${h}" section`);
    }
  }

  // starter code
  const starters = Object.keys(s.starterCode ?? {}).map(Number);
  for (const id of REQUIRED_STARTERS) {
    if (!starters.includes(id)) fail(slug, `starterCode missing language ${id}`);
  }
  if (s.starterCode?.["62"] && !s.starterCode["62"].includes("class Main")) {
    fail(slug, "Java starter must declare `public class Main`");
  }

  // reference solutions
  const sols = Object.keys(s.solutions ?? {}).map(Number);
  for (const id of REQUIRED_SOLUTIONS) {
    if (!sols.includes(id)) fail(slug, `solutions missing required language ${id}`);
  }
  if (s.solutions?.["62"] && !s.solutions["62"].includes("class Main")) {
    fail(slug, "Java solution must declare `public class Main`");
  }

  // wrong solutions
  const wrongCount = Object.keys(s.wrongSolutions ?? {}).length;
  if (wrongCount < 2) fail(slug, `needs >= 2 wrongSolutions, has ${wrongCount}`);

  // cases
  const cases = s.cases ?? [];
  const samples = cases.filter((c) => c.kind === "sample").length;
  const hidden = cases.filter((c) => c.kind === "hidden").length;
  if (frozen) {
    console.log(`  (frozen pre-existing problem: ${cases.length} cases, ${samples} sample + ${hidden} hidden — not held to the 3+4 rule)`);
    if (cases.length === 0) fail(slug, "frozen spec lost its cases");
  } else {
    if (cases.length !== 7) fail(slug, `expected exactly 7 cases, got ${cases.length}`);
    if (samples !== 3) fail(slug, `expected 3 sample cases, got ${samples}`);
    if (hidden !== 4) fail(slug, `expected 4 hidden cases, got ${hidden}`);
    const ord = cases.map((c) => c.ordinal).join(",");
    if (ord !== "1,2,3,4,5,6,7") fail(slug, `ordinals must be 1..7 in order, got ${ord}`);
    const kinds = cases.map((c) => c.kind).join(",");
    if (kinds !== "sample,sample,sample,hidden,hidden,hidden,hidden")
      fail(slug, `first 3 must be sample then 4 hidden, got ${kinds}`);
  }

  for (const c of cases) {
    const tag = `case #${c.ordinal}`;
    if (typeof c.stdin !== "string") fail(slug, `${tag} stdin is not a string`);
    if (typeof c.expectedOutput !== "string") fail(slug, `${tag} expectedOutput is not a string`);
    if ((c.weight ?? 1) !== 1) fail(slug, `${tag} weight is ${c.weight}, expected 1`);
    if (typeof c.expectedOutput === "string") {
      if (/^[ \t]/.test(c.expectedOutput))
        fail(slug, `${tag} expectedOutput starts with whitespace — Judge0 treats leading space as Wrong Answer`);
      if (/\n$/.test(c.expectedOutput))
        fail(slug, `${tag} expectedOutput has a trailing newline — strip it`);
      if (/[ \t]\n/.test(c.expectedOutput))
        fail(slug, `${tag} expectedOutput has trailing space before a newline — strip it`);
      if (c.expectedOutput.length === 0)
        fail(slug, `${tag} expectedOutput is empty`);
    }
  }

  // duplicate stdin across cases means wasted coverage
  const seen = new Map();
  for (const c of cases) {
    if (seen.has(c.stdin)) fail(slug, `case #${c.ordinal} duplicates the stdin of case #${seen.get(c.stdin)}`);
    else seen.set(c.stdin, c.ordinal);
  }

  if (failures === 0 || true) {
    console.log(`  cases=${cases.length} (${samples} sample/${hidden} hidden) starters=${starters.length} solutions=${sols.length} wrong=${wrongCount}`);
  }
}

console.log(failures === 0 ? "\nVALIDATION PASSED\n" : `\nVALIDATION FAILED — ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
