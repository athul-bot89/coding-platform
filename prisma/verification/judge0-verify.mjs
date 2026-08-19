#!/usr/bin/env node
// Judge0 verifier for problem specs.
//
// Usage: node .tmp-scripts/j0.mjs <spec.json> [--verbose] [--sync] [--async]
//
// Transport: this Judge0 instance's async worker pool can be down (GET /workers
// showing available:0 while submissions pile up "In Queue"). The verifier
// therefore probes /workers on startup and falls back to the SYNCHRONOUS
// endpoint (/submissions?wait=true), which Judge0 runs inline in the web process
// and so does not need workers. Both paths are real Judge0 executions producing
// real Judge0 verdicts; only the transport differs. --sync / --async force it.
//
// Spec shape:
// {
//   "slug": "count-vowels",
//   "timeLimitMs": 2000, "memoryLimitKb": 128000,
//   "solutions":      { "<languageId>": "<source that MUST pass every case>" },
//   "wrongSolutions": { "<label>": { "languageId": 71, "source": "...",
//                                    "mustFailAtLeast": 1 } },
//   "cases": [ { "ordinal": 1, "kind": "sample", "stdin": "...", "expectedOutput": "..." } ]
// }
//
// Exits 0 only when every reference solution passes every case AND every wrong
// solution is rejected by at least `mustFailAtLeast` cases.

import { readFileSync } from "node:fs";

const URL_BASE = process.env.JUDGE0_URL || "http://65.0.29.135:2358";
const TOKEN = process.env.JUDGE0_TOKEN || "d78b2194ec0b3adb43730c62c75dc2d7cf9529a36e2c59f6";
const SYNC_CONCURRENCY = Number(process.env.JUDGE0_SYNC_CONCURRENCY || 4);

const STATUS = {
  1: "In Queue", 2: "Processing", 3: "Accepted", 4: "Wrong Answer",
  5: "Time Limit Exceeded", 6: "Compilation Error", 7: "Runtime Error (SIGSEGV)",
  8: "Runtime Error (SIGXFSZ)", 9: "Runtime Error (SIGFPE)", 10: "Runtime Error (SIGABRT)",
  11: "Runtime Error (NZEC)", 12: "Runtime Error (Other)", 13: "Internal Error",
  14: "Exec Format Error",
};
const LANG = { 50: "C", 54: "C++", 62: "Java", 63: "JS", 71: "Python", 73: "Rust", 74: "TS" };
const FIELDS = "token,status,stdout,stderr,compile_output,message,time,memory";

const enc = (s) => Buffer.from(String(s), "utf8").toString("base64");
const dec = (b) => (b == null ? null : Buffer.from(b, "base64").toString("utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function workersAvailable() {
  try {
    const res = await fetch(`${URL_BASE}/workers`, { headers: { "X-Auth-Token": TOKEN } });
    if (!res.ok) return false;
    const data = await res.json();
    return (data ?? []).some((q) => (q.available ?? 0) > 0);
  } catch {
    return false;
  }
}

// ---------- async transport (batch submit + poll) ----------
async function runAsync(subs) {
  const tokens = [];
  for (let i = 0; i < subs.length; i += 20) {
    const chunk = subs.slice(i, i + 20);
    const res = await fetch(`${URL_BASE}/submissions/batch?base64_encoded=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": TOKEN },
      body: JSON.stringify({ submissions: chunk }),
    });
    if (!res.ok) throw new Error(`POST ${res.status}: ${await res.text()}`);
    for (const item of await res.json()) tokens.push(item.token ?? null);
  }

  const want = tokens.filter(Boolean);
  const out = new Map();
  for (let attempt = 0; attempt < 90; attempt++) {
    const missing = want.filter((t) => !out.has(t));
    if (missing.length === 0) break;
    for (let i = 0; i < missing.length; i += 20) {
      const chunk = missing.slice(i, i + 20);
      const res = await fetch(
        `${URL_BASE}/submissions/batch?tokens=${chunk.join(",")}&base64_encoded=true&fields=${FIELDS}`,
        { headers: { "X-Auth-Token": TOKEN } }
      );
      if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
      const data = await res.json();
      for (const item of data.submissions ?? []) {
        if (item?.token && item.status && item.status.id > 2) out.set(item.token, item);
      }
    }
    if (want.some((t) => !out.has(t))) await sleep(1200);
  }
  return tokens.map((t) => (t ? out.get(t) ?? null : null));
}

// ---------- sync transport (wait=true, no workers needed) ----------
async function runSync(subs) {
  const results = new Array(subs.length).fill(null);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= subs.length) return;
      for (let retry = 0; retry < 4; retry++) {
        try {
          const res = await fetch(
            `${URL_BASE}/submissions?base64_encoded=true&wait=true&fields=${FIELDS}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Auth-Token": TOKEN },
              body: JSON.stringify(subs[i]),
            }
          );
          if (res.status === 429 || res.status >= 500) { await sleep(800 * (retry + 1)); continue; }
          if (!res.ok) throw new Error(`POST ${res.status}: ${(await res.text()).slice(0, 200)}`);
          results[i] = await res.json();
          break;
        } catch (e) {
          if (retry === 3) results[i] = { status: null, message: enc(`verifier: ${e.message}`) };
          else await sleep(800 * (retry + 1));
        }
      }
      done++;
      if (done % 10 === 0 || done === subs.length) {
        process.stderr.write(`\r    ...${done}/${subs.length} submissions executed`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, subs.length) }, worker));
  process.stderr.write("\n");
  return results;
}

function show(s) {
  const j = JSON.stringify(s);
  return j == null ? "null" : j.length > 60 ? j.slice(0, 57) + '..."' : j;
}

// ---------- main ----------
const specPath = process.argv[2];
if (!specPath) { console.error("usage: node j0.mjs <spec.json>"); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const cases = spec.cases;
const cpu = (spec.timeLimitMs ?? 2000) / 1000;
const mem = spec.memoryLimitKb ?? 128000;

const jobs = [];
for (const [langId, source] of Object.entries(spec.solutions ?? {})) {
  for (const c of cases)
    jobs.push({ group: `ref:${LANG[langId] ?? langId}`, expectPass: true, langId: Number(langId), source, c });
}
for (const [label, w] of Object.entries(spec.wrongSolutions ?? {})) {
  for (const c of cases)
    jobs.push({ group: `bad:${label}`, expectPass: false, langId: w.languageId, source: w.source, c, mustFailAtLeast: w.mustFailAtLeast ?? 1 });
}
if (jobs.length === 0) { console.error("spec has no solutions to verify"); process.exit(2); }

let mode = process.argv.includes("--sync") ? "sync" : process.argv.includes("--async") ? "async" : null;
if (mode === null) mode = (await workersAvailable()) ? "async" : "sync";

console.log(`\n=== ${spec.slug} — ${jobs.length} Judge0 submissions (${cases.length} cases), transport=${mode} ===`);
if (mode === "sync") {
  console.log("    (async worker pool reports no available workers; using /submissions?wait=true — same Judge0, same verdicts)");
}

const subs = jobs.map((j) => ({
  language_id: j.langId,
  source_code: enc(j.source),
  stdin: enc(j.c.stdin),
  expected_output: enc(j.c.expectedOutput),
  cpu_time_limit: cpu,
  memory_limit: mem,
}));

const raw = mode === "sync" ? await runSync(subs) : await runAsync(subs);

let hardFail = 0;
const byGroup = new Map();
jobs.forEach((j, i) => {
  const r = raw[i];
  const sid = r?.status?.id ?? 0;
  if (!byGroup.has(j.group)) byGroup.set(j.group, []);
  byGroup.get(j.group).push({ j, sid, r });
});

for (const [group, rows] of byGroup) {
  const expectPass = rows[0].j.expectPass;
  const passed = rows.filter((x) => x.sid === 3).length;
  const okGroup = expectPass
    ? passed === rows.length
    : rows.length - passed >= (rows[0].j.mustFailAtLeast ?? 1);
  if (!okGroup) hardFail++;
  console.log(`\n-- ${group} ${okGroup ? "OK" : "*** PROBLEM ***"}  (${passed}/${rows.length} accepted, expected ${expectPass ? "all pass" : "some fail"})`);
  for (const { j, sid, r } of rows) {
    const bad = expectPass && sid !== 3;
    const mark = sid === 3 ? "pass" : "FAIL";
    let line = `  #${String(j.c.ordinal).padStart(2)} ${(j.c.kind ?? "").padEnd(6)} ${mark.padEnd(4)} ${(STATUS[sid] ?? "no-result").padEnd(24)} ${r?.time ?? "-"}s`;
    if (bad || (sid !== 3 && process.argv.includes("--verbose"))) {
      line += `\n        stdin=${show(j.c.stdin)}\n        want =${show(j.c.expectedOutput)}\n        got  =${show(r?.stdout != null ? dec(r.stdout) : null)}`;
      const err = r?.compile_output ? dec(r.compile_output) : r?.stderr ? dec(r.stderr) : r?.message ? dec(r.message) : null;
      if (err) line += `\n        err  =${show(String(err).slice(0, 400))}`;
    }
    console.log(line);
  }
}

console.log(`\n=== ${spec.slug}: ${hardFail === 0 ? "ALL CHECKS PASSED" : `${hardFail} GROUP(S) FAILED`} (transport=${mode}) ===\n`);
process.exit(hardFail === 0 ? 0 : 1);
