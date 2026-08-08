import { describe, it, expect } from "vitest";
import { HttpError } from "@/lib/fetch-json";

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
