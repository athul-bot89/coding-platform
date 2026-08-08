import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpError, fetchJson, postJson, errorMessage } from "@/lib/fetch-json";

describe("fetch-json: HttpError", () => {
  it("stores status and message", () => {
    const err = new HttpError(403, "Forbidden");
    expect(err.status).toBe(403);
    expect(err.message).toBe("Forbidden");
    expect(err.name).toBe("HttpError");
    expect(err.body).toBeNull();
  });

  it("stores optional body", () => {
    const body = { ended: true, reason: "time" };
    const err = new HttpError(409, "Conflict", body);
    expect(err.body).toEqual(body);
  });

  it("is an instance of Error", () => {
    const err = new HttpError(500, "Server Error");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("fetchJson", () => {
  const fetchMock = vi.fn();

  /** A Response-alike; only what fetchJson touches. */
  function reply(status: number, body: unknown, { json = true } = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: json ? async () => body : async () => { throw new SyntaxError("Unexpected token <"); },
    };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed body on success", async () => {
    fetchMock.mockResolvedValue(reply(200, { problems: [1, 2] }));

    await expect(fetchJson("/api/problems")).resolves.toEqual({ problems: [1, 2] });
    expect(fetchMock).toHaveBeenCalledWith("/api/problems", undefined);
  });

  it("returns null for a success with no body", async () => {
    fetchMock.mockResolvedValue(reply(204, null, { json: false }));

    await expect(fetchJson("/api/session/1/metrics")).resolves.toBeNull();
  });

  it("throws HttpError carrying the server's own error message", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "Forbidden" }));

    // This is the whole point of the module: an error body must never be
    // returned as if it were data.
    await expect(fetchJson("/api/admin/users")).rejects.toThrow(HttpError);
    await expect(fetchJson("/api/admin/users")).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    });
  });

  it("exposes the whole error body, so callers can read flags like `ended`", async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "Time is up", ended: true, state: "auto_submitted" }));

    const err = await fetchJson("/api/session/1/submit").catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: "Time is up", ended: true, state: "auto_submitted" });
  });

  it("falls back to a status-derived message when the failure has no JSON body", async () => {
    fetchMock.mockResolvedValue(reply(502, null, { json: false }));

    const err = await fetchJson("/api/problems").catch((e) => e);

    expect(err.message).toBe("Request failed (502)");
    expect(err.body).toBeNull();
  });

  it("falls back when the failure body has no `error` key", async () => {
    fetchMock.mockResolvedValue(reply(500, { detail: "something else" }));

    const err = await fetchJson("/api/problems").catch((e) => e);

    expect(err.message).toBe("Request failed (500)");
    expect(err.body).toEqual({ detail: "something else" });
  });

  it("lets a network-level rejection through untouched", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchJson("/api/problems")).rejects.toThrow("Failed to fetch");
  });
});

describe("postJson", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a JSON-encoded body with the right content type", async () => {
    await postJson("/api/session/1/event", { event: "tab_switch", detail: null });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/session/1/event");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ event: "tab_switch", detail: null });
  });

  it("honours an overridden method", async () => {
    await postJson("/api/admin/users", { role: "admin" }, { method: "PATCH" });

    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
  });

  it("keeps Content-Type when the caller adds headers of their own", async () => {
    await postJson("/api/session/1/heartbeat", { tabId: "t1" }, { headers: { "X-Tab": "t1" } });

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
      "X-Tab": "t1",
    });
  });

  it("preserves other init options such as keepalive", async () => {
    await postJson("/api/session/1/finish", { reason: "manual" }, { keepalive: true });

    const init = fetchMock.mock.calls[0][1];
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ reason: "manual" });
  });

  it("throws HttpError on a non-2xx just like fetchJson", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Write some code first" }),
    });

    await expect(postJson("/api/session/1/submit", {})).rejects.toMatchObject({
      status: 400,
      message: "Write some code first",
    });
  });
});

describe("errorMessage", () => {
  it("uses an HttpError's message", () => {
    expect(errorMessage(new HttpError(409, "This test has ended"))).toBe("This test has ended");
  });

  it("uses a plain Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back for an Error with no message", () => {
    expect(errorMessage(new Error(""))).toBe("Something went wrong");
    expect(errorMessage(new Error(""), "Could not save")).toBe("Could not save");
  });

  it("falls back for anything that is not an Error", () => {
    expect(errorMessage("a string")).toBe("Something went wrong");
    expect(errorMessage(null)).toBe("Something went wrong");
    expect(errorMessage({ error: "nope" }, "Could not load")).toBe("Could not load");
  });
});
