// Client-side fetch helper.
//
// Every page here used to do `res.json().then(setState)` with no `res.ok` check,
// so an error body — `{ error: "Forbidden" }` — was stored and rendered as if it
// were data, and the first `.map()` on it took the whole screen down. Throwing
// on a non-2xx keeps that mistake from being re-introduced one page at a time.

export class HttpError extends Error {
  readonly status: number;
  /** Parsed error body, when the server sent one — e.g. `{ ended: true }`. */
  readonly body: any;

  constructor(status: number, message: string, body?: any) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body ?? null;
  }
}

async function parseBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null; // empty or non-JSON body (204, HTML error page, dropped connection)
  }
}

/**
 * Fetch and parse JSON, throwing `HttpError` on any non-2xx.
 *
 * Callers that care about a specific failure — the 409 a finished test replies
 * with, say — catch `HttpError` and read `.status` / `.body`.
 */
export async function fetchJson<T = any>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = await parseBody(res);

  if (!res.ok) {
    throw new HttpError(res.status, body?.error || `Request failed (${res.status})`, body);
  }

  return body as T;
}

/** Convenience wrapper for POST/PATCH with a JSON body. */
export function postJson<T = any>(
  input: RequestInfo | URL,
  body: unknown,
  init: RequestInit = {}
): Promise<T> {
  // `init` first: the JSON body and its Content-Type are what this helper is for,
  // so they must survive a caller passing headers of their own alongside them.
  return fetchJson<T>(input, {
    ...init,
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    body: JSON.stringify(body),
  });
}

export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
