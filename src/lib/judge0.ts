const JUDGE0_URL = process.env.JUDGE0_URL || "http://65.0.29.135:2358";
const JUDGE0_TOKEN = process.env.JUDGE0_TOKEN || "";

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64");
const dec = (b: string | null) =>
  b == null ? null : Buffer.from(b, "base64").toString("utf8");

interface SubmissionPayload {
  language_id: number;
  source_code: string;
  stdin: string;
  expected_output: string;
  cpu_time_limit?: number;
  memory_limit?: number;
}

interface SubmissionResult {
  token: string;
  status?: { id: number; description: string };
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  time: string | null;
  memory: number | null;
  exit_code?: number | null;
}

export async function createSubmission(payload: SubmissionPayload): Promise<string> {
  const body = {
    language_id: payload.language_id,
    source_code: enc(payload.source_code),
    stdin: enc(payload.stdin),
    expected_output: enc(payload.expected_output),
    cpu_time_limit: payload.cpu_time_limit ?? 5.0,
    memory_limit: payload.memory_limit ?? 128000,
  };

  const res = await fetch(
    `${JUDGE0_URL}/submissions?base64_encoded=true&wait=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": JUDGE0_TOKEN,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Judge0 POST failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.token;
}

export async function createBatchSubmissions(
  submissions: SubmissionPayload[]
): Promise<string[]> {
  // Judge0 batch max is 20, chunk if needed
  const chunks: SubmissionPayload[][] = [];
  for (let i = 0; i < submissions.length; i += 20) {
    chunks.push(submissions.slice(i, i + 20));
  }

  const tokens: string[] = [];
  for (const chunk of chunks) {
    const body = {
      submissions: chunk.map((s) => ({
        language_id: s.language_id,
        source_code: enc(s.source_code),
        stdin: enc(s.stdin),
        expected_output: enc(s.expected_output),
        cpu_time_limit: s.cpu_time_limit ?? 5.0,
        memory_limit: s.memory_limit ?? 128000,
      })),
    };

    const res = await fetch(
      `${JUDGE0_URL}/submissions/batch?base64_encoded=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": JUDGE0_TOKEN,
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Judge0 batch POST failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    for (const item of data) {
      if (item.token) {
        tokens.push(item.token);
      } else {
        tokens.push(""); // failed slot
      }
    }
  }

  return tokens;
}

export async function getSubmission(token: string): Promise<SubmissionResult> {
  const res = await fetch(
    `${JUDGE0_URL}/submissions/${token}?base64_encoded=true&fields=token,status,stdout,stderr,compile_output,message,time,memory,exit_code`,
    {
      headers: { "X-Auth-Token": JUDGE0_TOKEN },
    }
  );

  if (!res.ok) {
    throw new Error(`Judge0 GET failed (${res.status})`);
  }

  const data = await res.json();
  return {
    token: data.token,
    status: data.status,
    stdout: dec(data.stdout),
    stderr: dec(data.stderr),
    compile_output: dec(data.compile_output),
    message: data.message,
    time: data.time,
    memory: data.memory,
    exit_code: data.exit_code,
  };
}

export async function getBatchSubmissions(tokens: string[]): Promise<SubmissionResult[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += 20) {
    chunks.push(tokens.slice(i, i + 20));
  }

  const results: SubmissionResult[] = [];
  for (const chunk of chunks) {
    const res = await fetch(
      `${JUDGE0_URL}/submissions/batch?tokens=${chunk.join(",")}&base64_encoded=true&fields=token,status,stdout,stderr,compile_output,message,time,memory,exit_code`,
      {
        headers: { "X-Auth-Token": JUDGE0_TOKEN },
      }
    );

    if (!res.ok) {
      throw new Error(`Judge0 batch GET failed (${res.status})`);
    }

    const data = await res.json();
    for (const item of data.submissions) {
      if (item == null) {
        results.push({
          token: "",
          stdout: null,
          stderr: null,
          compile_output: null,
          message: "Unknown token",
          time: null,
          memory: null,
        });
      } else {
        results.push({
          token: item.token,
          status: item.status,
          stdout: dec(item.stdout),
          stderr: dec(item.stderr),
          compile_output: dec(item.compile_output),
          message: item.message,
          time: item.time,
          memory: item.memory,
          exit_code: item.exit_code,
        });
      }
    }
  }

  return results;
}

export function isTerminal(statusId: number): boolean {
  return statusId > 2;
}
