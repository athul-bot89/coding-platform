import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { createBatchSubmissions, getSubmission } from "@/lib/judge0";

/**
 * POST /api/admin/problems/test-run
 *
 * Run code against ALL test cases at once using Judge0 batch API.
 * Returns per-case results so the admin can verify the full problem in one click.
 *
 * Body: { languageId, sourceCode, timeLimitMs?, memoryLimitKb?, testCases: [{stdin, expectedOutput}] }
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const body = await req.json().catch(() => ({}));
  const { languageId, sourceCode, timeLimitMs, memoryLimitKb, testCases } = body;

  if (typeof languageId !== "number" || !Number.isInteger(languageId))
    return NextResponse.json({ error: "languageId must be an integer" }, { status: 400 });
  if (typeof sourceCode !== "string" || !sourceCode.trim())
    return NextResponse.json({ error: "sourceCode is required" }, { status: 400 });
  if (!Array.isArray(testCases) || testCases.length === 0)
    return NextResponse.json({ error: "testCases array is required" }, { status: 400 });
  if (testCases.length > 20)
    return NextResponse.json({ error: "Maximum 20 test cases per run" }, { status: 400 });

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    if (typeof tc.stdin !== "string")
      return NextResponse.json({ error: `Test case ${i + 1}: stdin is required` }, { status: 400 });
    if (typeof tc.expectedOutput !== "string")
      return NextResponse.json({ error: `Test case ${i + 1}: expectedOutput is required` }, { status: 400 });
  }

  const cpuLimit = Number(timeLimitMs ?? 5000) / 1000;
  const memLimit = Number(memoryLimitKb ?? 128000);

  try {
    const tokens = await createBatchSubmissions(
      testCases.map((tc: any) => ({
        language_id: languageId,
        source_code: sourceCode,
        stdin: tc.stdin,
        expected_output: tc.expectedOutput,
        cpu_time_limit: cpuLimit,
        memory_limit: memLimit,
      }))
    );

    // Poll all tokens until all reach a terminal state (max ~20 seconds)
    const terminalStatuses = new Set([3, 4, 5, 6, 11, 12, 13, 14]);
    const results = new Array(tokens.length).fill(null);
    let polls = 0;

    while (polls < 20) {
      const pending = tokens
        .map((t, i) => ({ t, i }))
        .filter(({ t, i }) => t && (!results[i] || !terminalStatuses.has(results[i]?.status?.id ?? 0)));

      if (pending.length === 0) break;

      await new Promise((r) => setTimeout(r, 1000));

      await Promise.all(
        pending.map(async ({ t, i }) => {
          try {
            results[i] = await getSubmission(t);
          } catch { /* retry next poll */ }
        })
      );
      polls++;
    }

    const response = results.map((r, i) => ({
      testCase: i + 1,
      statusId: r?.status?.id ?? null,
      statusDescription: r?.status?.description ?? "Timeout / No Response",
      stdout: r?.stdout ?? null,
      stderr: r?.stderr ?? null,
      compileOutput: r?.compile_output ?? null,
      time: r?.time ?? null,
      memory: r?.memory ?? null,
      passed: r?.status?.id === 3,
    }));

    return NextResponse.json({
      results,
      summary: {
        total: response.length,
        passed: response.filter((r) => r.passed).length,
        failed: response.filter((r) => !r.passed).length,
        allPassed: response.every((r) => r.passed),
      },
      details: response,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Judge0 error: ${err.message}` },
      { status: 502 }
    );
  }
}
