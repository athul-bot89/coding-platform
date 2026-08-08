import { describe, it, expect } from "vitest";
import {
  violationLevel,
  isCountedEvent,
  isSilentEvent,
  truncateEventDetail,
  COUNTED_EVENTS,
  LOGGED_ONLY,
  SILENT_EVENTS,
  VALID_EVENTS,
  DEFAULT_MAX_VIOLATIONS,
  EVENT_DETAIL_MAX,
  BLOCKED_MESSAGES,
  VIOLATION_MESSAGES,
} from "@/lib/proctor-config";

describe("proctor-config", () => {
  describe("violationLevel", () => {
    it("returns 'none' when count is 0", () => {
      expect(violationLevel(0, 5)).toBe("none");
    });

    it("returns 'logged' when max is 0 (auto-submit disabled)", () => {
      expect(violationLevel(1, 0)).toBe("logged");
      expect(violationLevel(3, 0)).toBe("logged");
      expect(violationLevel(1, -1)).toBe("logged");
    });

    it("returns 'noted' for early violations", () => {
      expect(violationLevel(1, 5)).toBe("noted");
      expect(violationLevel(2, 5)).toBe("noted");
    });

    it("returns 'close' when 2 remain", () => {
      expect(violationLevel(3, 5)).toBe("close");
    });

    it("returns 'final' when 1 remains", () => {
      expect(violationLevel(4, 5)).toBe("final");
    });

    it("returns 'final' when at or past the limit", () => {
      expect(violationLevel(5, 5)).toBe("final");
      expect(violationLevel(6, 5)).toBe("final");
    });
  });

  describe("isCountedEvent", () => {
    it("recognises counted events", () => {
      expect(isCountedEvent("fullscreen_exit")).toBe(true);
      expect(isCountedEvent("tab_switch")).toBe(true);
      expect(isCountedEvent("window_blur")).toBe(true);
      expect(isCountedEvent("multi_display")).toBe(true);
    });

    it("rejects non-counted events", () => {
      expect(isCountedEvent("paste")).toBe(false);
      expect(isCountedEvent("copy")).toBe(false);
      expect(isCountedEvent("connection_lost")).toBe(false);
      expect(isCountedEvent("made_up_event")).toBe(false);
    });
  });

  describe("isSilentEvent", () => {
    it("recognises silent events", () => {
      expect(isSilentEvent("connection_lost")).toBe(true);
      expect(isSilentEvent("connection_restored")).toBe(true);
    });

    it("rejects non-silent events", () => {
      expect(isSilentEvent("paste")).toBe(false);
      expect(isSilentEvent("fullscreen_exit")).toBe(false);
    });
  });

  describe("truncateEventDetail", () => {
    it("returns null for non-string or empty input", () => {
      expect(truncateEventDetail(null)).toBeNull();
      expect(truncateEventDetail(undefined)).toBeNull();
      expect(truncateEventDetail(123)).toBeNull();
      expect(truncateEventDetail("")).toBeNull();
    });

    it("passes short strings unchanged", () => {
      expect(truncateEventDetail("tab switch")).toBe("tab switch");
    });

    it("truncates at EVENT_DETAIL_MAX", () => {
      const long = "x".repeat(EVENT_DETAIL_MAX + 100);
      const result = truncateEventDetail(long);
      expect(result).toHaveLength(EVENT_DETAIL_MAX);
    });
  });

  describe("VALID_EVENTS covers all categories", () => {
    it("is the union of COUNTED + LOGGED_ONLY + SILENT", () => {
      const expected = [...COUNTED_EVENTS, ...LOGGED_ONLY, ...SILENT_EVENTS];
      expect(VALID_EVENTS).toEqual(expected);
    });
  });

  describe("BLOCKED_MESSAGES has entries for all logged-only events", () => {
    it("every logged-only event has a user-facing message", () => {
      for (const evt of LOGGED_ONLY) {
        expect(BLOCKED_MESSAGES[evt]).toBeDefined();
        expect(typeof BLOCKED_MESSAGES[evt]).toBe("string");
      }
    });
  });

  describe("VIOLATION_MESSAGES has all non-none levels", () => {
    it("covers logged, noted, close, final", () => {
      expect(VIOLATION_MESSAGES.logged).toBeDefined();
      expect(VIOLATION_MESSAGES.noted).toBeDefined();
      expect(VIOLATION_MESSAGES.close).toBeDefined();
      expect(VIOLATION_MESSAGES.final).toBeDefined();
    });
  });

  describe("DEFAULT_MAX_VIOLATIONS", () => {
    it("is a positive integer", () => {
      expect(DEFAULT_MAX_VIOLATIONS).toBeGreaterThan(0);
      expect(Number.isInteger(DEFAULT_MAX_VIOLATIONS)).toBe(true);
    });
  });
});
