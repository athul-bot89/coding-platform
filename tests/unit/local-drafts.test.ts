import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadDrafts,
  rememberDraft,
  markSynced,
  dirtyDrafts,
  isDraftDirty,
  pruneDrafts,
  clearDrafts,
} from "@/lib/local-drafts";

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) delete store[k]; }),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock });

describe("local-drafts", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  const SESSION = "session-123";

  describe("loadDrafts / rememberDraft", () => {
    it("returns empty object for unknown session", () => {
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("stores and retrieves a draft", () => {
      rememberDraft(SESSION, "prob-1", "print('hi')", 71, 1000);
      const drafts = loadDrafts(SESSION);
      expect(drafts["prob-1"]).toBeDefined();
      expect(drafts["prob-1"].code).toBe("print('hi')");
      expect(drafts["prob-1"].languageId).toBe(71);
      expect(drafts["prob-1"].savedAt).toBe(1000);
    });

    it("updates existing draft preserving syncedAt", () => {
      rememberDraft(SESSION, "prob-1", "v1", 71, 1000);
      markSynced(SESSION, "prob-1", 1000);
      rememberDraft(SESSION, "prob-1", "v2", 71, 2000);

      const drafts = loadDrafts(SESSION);
      expect(drafts["prob-1"].code).toBe("v2");
      expect(drafts["prob-1"].savedAt).toBe(2000);
      expect(drafts["prob-1"].syncedAt).toBe(1000);
    });

    it("rejects oversized code", () => {
      const huge = "x".repeat(200_001);
      const result = rememberDraft(SESSION, "prob-1", huge, 71);
      expect(result).toBe(false);
    });
  });

  describe("markSynced", () => {
    it("advances syncedAt to the sent timestamp", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      markSynced(SESSION, "prob-1", 1000);
      const drafts = loadDrafts(SESSION);
      expect(drafts["prob-1"].syncedAt).toBe(1000);
    });

    it("does not regress syncedAt", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 2000);
      markSynced(SESSION, "prob-1", 2000);
      markSynced(SESSION, "prob-1", 1500); // older ack arrives late
      const drafts = loadDrafts(SESSION);
      expect(drafts["prob-1"].syncedAt).toBe(2000);
    });
  });

  describe("dirtyDrafts", () => {
    it("returns drafts where savedAt > syncedAt", () => {
      rememberDraft(SESSION, "prob-1", "code1", 71, 1000);
      rememberDraft(SESSION, "prob-2", "code2", 62, 2000);
      markSynced(SESSION, "prob-1", 1000); // prob-1 is clean

      const dirty = dirtyDrafts(SESSION);
      expect(dirty).toHaveLength(1);
      expect(dirty[0].problemId).toBe("prob-2");
    });

    it("returns empty when all synced", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      markSynced(SESSION, "prob-1", 1000);
      expect(dirtyDrafts(SESSION)).toHaveLength(0);
    });
  });

  describe("isDraftDirty", () => {
    it("returns true when savedAt > syncedAt", () => {
      expect(isDraftDirty({ code: "x", languageId: 71, savedAt: 200, syncedAt: 100 })).toBe(true);
    });

    it("returns false when synced", () => {
      expect(isDraftDirty({ code: "x", languageId: 71, savedAt: 100, syncedAt: 100 })).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isDraftDirty(undefined)).toBe(false);
    });
  });

  describe("pruneDrafts", () => {
    it("removes drafts for problems not in the keep list", () => {
      rememberDraft(SESSION, "prob-1", "code1", 71, 1000);
      rememberDraft(SESSION, "prob-2", "code2", 62, 2000);
      rememberDraft(SESSION, "prob-3", "code3", 63, 3000);

      pruneDrafts(SESSION, ["prob-1", "prob-3"]);
      const drafts = loadDrafts(SESSION);
      expect(drafts["prob-1"]).toBeDefined();
      expect(drafts["prob-2"]).toBeUndefined();
      expect(drafts["prob-3"]).toBeDefined();
    });
  });

  describe("clearDrafts", () => {
    it("removes all drafts for a session", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      clearDrafts(SESSION);
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("leaves other sessions' mirrors alone", () => {
      rememberDraft(SESSION, "prob-1", "mine", 71, 1000);
      rememberDraft("other-session", "prob-1", "theirs", 71, 1000);

      clearDrafts(SESSION);

      expect(loadDrafts(SESSION)).toEqual({});
      expect(loadDrafts("other-session")["prob-1"].code).toBe("theirs");
    });

    it("swallows a storage error rather than throwing mid-test", () => {
      localStorageMock.removeItem.mockImplementationOnce(() => {
        throw new Error("SecurityError");
      });
      expect(() => clearDrafts(SESSION)).not.toThrow();
    });
  });

  describe("keeps sessions apart", () => {
    it("stores each session's drafts under its own key", () => {
      rememberDraft(SESSION, "prob-1", "mine", 71, 1000);
      rememberDraft("other-session", "prob-1", "theirs", 62, 2000);

      expect(loadDrafts(SESSION)["prob-1"].code).toBe("mine");
      expect(loadDrafts("other-session")["prob-1"].code).toBe("theirs");
    });
  });

  describe("surviving a bad storage slot", () => {
    it("reads a corrupted write as empty", () => {
      localStorageMock.setItem("test-drafts:" + SESSION, "{not json");
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("reads somebody else's array as empty", () => {
      localStorageMock.setItem("test-drafts:" + SESSION, JSON.stringify(["nope"]));
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("reads a JSON null as empty", () => {
      localStorageMock.setItem("test-drafts:" + SESSION, "null");
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("overwrites a corrupted slot on the next edit", () => {
      localStorageMock.setItem("test-drafts:" + SESSION, "{not json");

      expect(rememberDraft(SESSION, "prob-1", "recovered", 71, 1000)).toBe(true);
      expect(loadDrafts(SESSION)["prob-1"].code).toBe("recovered");
    });
  });

  describe("when the browser refuses the write", () => {
    it("reports failure so the candidate can be told their code is editor-only", () => {
      localStorageMock.setItem.mockImplementationOnce(() => {
        throw new Error("QuotaExceededError");
      });

      expect(rememberDraft(SESSION, "prob-1", "code", 71, 1000)).toBe(false);
    });

    it("reports success on a normal write", () => {
      expect(rememberDraft(SESSION, "prob-1", "code", 71, 1000)).toBe(true);
    });
  });

  describe("markSynced on a draft that is gone", () => {
    it("is a no-op and writes nothing", () => {
      markSynced(SESSION, "prob-unknown", 1000);

      expect(loadDrafts(SESSION)).toEqual({});
      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });
  });

  describe("pruneDrafts", () => {
    it("clears everything when the session serves no problems", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      pruneDrafts(SESSION, []);
      expect(loadDrafts(SESSION)).toEqual({});
    });

    it("writes nothing when every draft is still wanted", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      localStorageMock.setItem.mockClear();

      pruneDrafts(SESSION, ["prob-1"]);

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it("keeps the synced state of the drafts it keeps", () => {
      rememberDraft(SESSION, "prob-1", "code", 71, 1000);
      markSynced(SESSION, "prob-1", 1000);
      rememberDraft(SESSION, "prob-2", "code2", 71, 2000);

      pruneDrafts(SESSION, ["prob-1"]);

      expect(loadDrafts(SESSION)["prob-1"].syncedAt).toBe(1000);
      expect(dirtyDrafts(SESSION)).toHaveLength(0);
    });
  });
});
