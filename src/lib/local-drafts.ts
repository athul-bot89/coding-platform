// A mirror of the editor on the candidate's own machine.
//
// The server draft is the record, but it is a network call away, and a candidate
// who loses their connection keeps typing. Every edit lands here synchronously
// first, so the worst an outage — or a crash, or a closed lid — can cost is the
// keystroke in flight. What has not reached the server is marked dirty and
// re-sent until it does.
//
// `savedAt` and `syncedAt` are both client-clock values and are only ever
// compared with each other, so a skewed clock cannot make a draft look stale.
// The server's clock never enters into it.

export interface LocalDraft {
  code: string;
  languageId: number;
  /** When the candidate last changed this draft. */
  savedAt: number;
  /** The `savedAt` the server has acknowledged. Below `savedAt` means unsent. */
  syncedAt: number;
}

/** problemId → draft, for one session. */
export type LocalDrafts = Record<string, LocalDraft>;

export interface DirtyDraft {
  problemId: string;
  draft: LocalDraft;
}

const PREFIX = "test-drafts:";

/**
 * A single draft larger than this is not code anyone typed, and writing it would
 * risk blowing the origin's storage quota and taking every *other* problem's
 * mirror down with it. The server save is still attempted either way.
 */
const MAX_CODE_CHARS = 200_000;

function key(sessionId: string): string {
  return PREFIX + sessionId;
}

function read(sessionId: string): LocalDrafts {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key(sessionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Anything else in this slot is someone else's data or a corrupted write;
    // treating it as empty is better than throwing inside a live test.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** False when the browser refused the write — private mode, or a full quota. */
function write(sessionId: string, drafts: LocalDrafts): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key(sessionId), JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

export function loadDrafts(sessionId: string): LocalDrafts {
  return read(sessionId);
}

/**
 * Record an edit locally. Returns false if it could not be stored, which is worth
 * telling the candidate about — it means their code lives only in the editor.
 */
export function rememberDraft(
  sessionId: string,
  problemId: string,
  code: string,
  languageId: number,
  now = Date.now()
): boolean {
  if (code.length > MAX_CODE_CHARS) return false;
  const drafts = read(sessionId);
  const previous = drafts[problemId];
  drafts[problemId] = {
    code,
    languageId,
    savedAt: now,
    syncedAt: previous?.syncedAt ?? 0,
  };
  return write(sessionId, drafts);
}

/**
 * Mark what the server has accepted. Takes the `savedAt` that was actually sent,
 * so an edit made while the request was in flight stays dirty instead of being
 * marked clean by a response that predates it.
 */
export function markSynced(sessionId: string, problemId: string, sentSavedAt: number): void {
  const drafts = read(sessionId);
  const draft = drafts[problemId];
  if (!draft) return;
  drafts[problemId] = { ...draft, syncedAt: Math.max(draft.syncedAt, sentSavedAt) };
  write(sessionId, drafts);
}

/** Everything typed since the server last acknowledged it. */
export function dirtyDrafts(sessionId: string): DirtyDraft[] {
  const drafts = read(sessionId);
  return Object.entries(drafts)
    .filter(([, d]) => d.savedAt > d.syncedAt)
    .map(([problemId, draft]) => ({ problemId, draft }));
}

export function isDraftDirty(draft: LocalDraft | undefined): boolean {
  return !!draft && draft.savedAt > draft.syncedAt;
}

/**
 * Forget problems this session is no longer serving, so a question pulled from an
 * assessment mid-test stops being re-sent to an endpoint that now rejects it.
 */
export function pruneDrafts(sessionId: string, keep: string[]): void {
  const drafts = read(sessionId);
  const allowed = new Set(keep);
  let changed = false;
  for (const problemId of Object.keys(drafts)) {
    if (!allowed.has(problemId)) {
      delete drafts[problemId];
      changed = true;
    }
  }
  if (changed) write(sessionId, drafts);
}

/** Drop the mirror once the test is over and the server holds everything. */
export function clearDrafts(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(sessionId));
  } catch {
    // Nothing to do — a stale mirror is only ever read for this session id.
  }
}
