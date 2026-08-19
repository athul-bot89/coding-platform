# Verification harness for the programming-basics question set

`judge0-verify.mjs` submits every reference solution and every deliberately-wrong
solution in a spec against every test case on the real Judge0 instance, and exits
non-zero unless each reference solution passes all cases and each wrong solution
is rejected by at least one case. `prisma/programming-basics.json` carries those
solutions alongside the questions, so the whole set can be re-checked later:

    node prisma/verification/judge0-verify.mjs <spec.json>

A spec needs `slug`, `timeLimitMs`, `memoryLimitKb`, `solutions`,
`wrongSolutions` and `cases`; the entries in programming-basics.json are already
in that shape.

`validate-specs.mjs` is the structural gate (3 visible + 4 hidden, ordinals 1..7,
all seven starter languages, no leading/trailing whitespace traps in expected
output). It resolves a slug to `.tmp-scripts/specs/<slug>.json`, the authoring
location used when the set was built; point it at wherever specs live if you
reuse it.

## Two things to know about this Judge0 instance

1. **The async worker pool can be down.** `GET /workers` reporting
   `available: 0` while submissions sit "In Queue" means the resque workers are
   dead. `src/lib/judge0.ts` submits with `wait=false`, so the platform itself
   stalls in that state. The verifier detects this and falls back to the
   synchronous `/submissions?wait=true` endpoint, which Judge0 runs inline in the
   web process and so needs no workers. Force with `--sync` / `--async`.

2. **TypeScript (language 74) compilation is flaky here.** `tsc` intermittently
   trips Judge0's compilation time limit and returns
   `Compilation Error / "Compilation time limit exceeded."` — reproducible even
   for `console.log(7);` when the box is loaded. TS reference solutions are
   therefore kept out of the verification gate (see `solutionsExcluded` in the
   spec files) even though they were confirmed passing on an idle box.

## Judge0 output comparison, measured on this instance

- Trailing newline, trailing spaces on a line, and extra trailing blank lines are
  all **ignored**.
- **Leading** whitespace is **not** ignored — it produces Wrong Answer.

So expected outputs are stored with no trailing newline and must never begin with
a space.
