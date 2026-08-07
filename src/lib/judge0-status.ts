// Judge0 status codes — the single source of truth for reading a verdict.
//
// Deliberately free of server-only imports (no prisma, no judge0 client): the
// candidate and admin pages render verdicts too, so this module has to be safe
// to pull into the browser bundle. Anything that needs a DB or an HTTP call
// belongs in lib/grading.ts or lib/judge0.ts instead.

export const JUDGE0_IN_QUEUE = 1;
export const JUDGE0_PROCESSING = 2;
export const JUDGE0_ACCEPTED = 3;
export const JUDGE0_WRONG_ANSWER = 4;
export const JUDGE0_TIME_LIMIT_EXCEEDED = 5;
export const JUDGE0_COMPILATION_ERROR = 6;
export const JUDGE0_INTERNAL_ERROR = 13;

export const JUDGE0_STATUS_LABELS: Record<number, string> = {
  1: "In Queue",
  2: "Processing",
  3: "Accepted",
  4: "Wrong Answer",
  5: "Time Limit Exceeded",
  6: "Compilation Error",
  7: "Runtime Error (SIGSEGV)",
  8: "Runtime Error (SIGXFSZ)",
  9: "Runtime Error (SIGFPE)",
  10: "Runtime Error (SIGABRT)",
  11: "Runtime Error (NZEC)",
  12: "Runtime Error",
  13: "Internal Error",
  14: "Exec Format Error",
};

export function statusLabel(statusId: number | null | undefined): string {
  if (!statusId) return "Pending";
  return JUDGE0_STATUS_LABELS[statusId] || "Error";
}

/** Judge0 keeps 1 and 2 for work still in flight; everything above is a verdict. */
export function isTerminalStatus(statusId: number | null | undefined): boolean {
  return !!statusId && statusId > JUDGE0_PROCESSING;
}

export function isAccepted(statusId: number | null | undefined): boolean {
  return statusId === JUDGE0_ACCEPTED;
}

/** Reached a verdict, and that verdict was not Accepted. */
export function isFailed(statusId: number | null | undefined): boolean {
  return isTerminalStatus(statusId) && statusId !== JUDGE0_ACCEPTED;
}

export function isPending(statusId: number | null | undefined): boolean {
  return !isTerminalStatus(statusId);
}
