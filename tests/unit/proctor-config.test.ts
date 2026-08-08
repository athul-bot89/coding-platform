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
  BLOCKED_FALLBACK,
  VIOLATION_MESSAGES,
  VIOLATION_BADGES,
  VIOLATION_OVERLAY,
  EVENT_LABELS,
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

    it("passes a string of exactly EVENT_DETAIL_MAX through unchanged", () => {
      const exact = "x".repeat(EVENT_DETAIL_MAX);
      expect(truncateEventDetail(exact)).toBe(exact);
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

    it("holds no duplicates", () => {
      expect(new Set(VALID_EVENTS).size).toBe(VALID_EVENTS.length);
    });

    it("keeps the three categories disjoint", () => {
      // An event in two categories would be both counted and logged-only, or
      // silently counted — every handler reads these lists in a different order.
      const counted = new Set<string>(COUNTED_EVENTS);
      const silent = new Set<string>(SILENT_EVENTS);

      for (const evt of LOGGED_ONLY) {
        expect(counted.has(evt), `${evt} is both counted and logged-only`).toBe(false);
        expect(silent.has(evt), `${evt} is both silent and logged-only`).toBe(false);
      }
      for (const evt of COUNTED_EVENTS) {
        expect(silent.has(evt), `${evt} is both counted and silent`).toBe(false);
      }
    });

    it("classifies every valid event as exactly one of counted / silent / logged-only", () => {
      for (const evt of VALID_EVENTS) {
        const flags = [isCountedEvent(evt), isSilentEvent(evt)].filter(Boolean);
        expect(flags.length, `${evt} is in more than one category`).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("BLOCKED_MESSAGES has entries for all logged-only events", () => {
    it("every logged-only event has a user-facing message", () => {
      for (const evt of LOGGED_ONLY) {
        expect(BLOCKED_MESSAGES[evt]).toBeDefined();
        expect(typeof BLOCKED_MESSAGES[evt]).toBe("string");
      }
    });

    it("wording for a blocked action never implies a strike was counted", () => {
      // These actions did not happen and cost the candidate nothing; copy that
      // sounds like a warning would be a lie about the tally.
      for (const evt of LOGGED_ONLY) {
        expect(BLOCKED_MESSAGES[evt]).not.toMatch(/violation|warning|automatically/i);
      }
    });

    it("gives multi_display its own wording rather than the 'disabled' fallback", () => {
      // A passive detection, not a blocked action — and the only counted event
      // that carries a blocked-style message.
      expect(BLOCKED_MESSAGES.multi_display).toBeDefined();
      expect(BLOCKED_MESSAGES.multi_display).not.toContain("disabled");
      expect(BLOCKED_FALLBACK).toBeTruthy();
    });
  });

  describe("candidate-facing copy covers every warning level", () => {
    const LEVELS = ["logged", "noted", "close", "final"] as const;

    it.each([
      ["VIOLATION_MESSAGES", VIOLATION_MESSAGES],
      ["VIOLATION_BADGES", VIOLATION_BADGES],
      ["VIOLATION_OVERLAY", VIOLATION_OVERLAY],
    ])("%s has a non-empty string for each level", (_name, table) => {
      for (const level of LEVELS) {
        expect(table[level]).toBeTruthy();
        expect(typeof table[level]).toBe("string");
      }
    });

    it("never shows the candidate their running tally", () => {
      // The budget only works while the count is unknown; a digit in any of this
      // copy turns it into a resource to spend down.
      for (const table of [VIOLATION_MESSAGES, VIOLATION_BADGES, VIOLATION_OVERLAY]) {
        for (const level of LEVELS) {
          expect(table[level], `${table[level]} leaks a number`).not.toMatch(/\d/);
        }
      }
    });

    it("returns a level that always has copy for it, for any counted violation", () => {
      for (const max of [0, 1, 2, 5, 10]) {
        for (let count = 1; count <= 12; count++) {
          const level = violationLevel(count, max);
          expect(level).not.toBe("none");
          expect(VIOLATION_MESSAGES[level as Exclude<typeof level, "none">]).toBeTruthy();
        }
      }
    });
  });

  describe("EVENT_LABELS", () => {
    it("labels every valid event, so no report row renders a raw enum", () => {
      for (const evt of VALID_EVENTS) {
        expect(EVENT_LABELS[evt], `no label for ${evt}`).toBeTruthy();
      }
    });

    it("labels nothing that is not a valid event", () => {
      for (const evt of Object.keys(EVENT_LABELS)) {
        expect(VALID_EVENTS, `${evt} is labelled but not accepted`).toContain(evt);
      }
    });
  });

  describe("DEFAULT_MAX_VIOLATIONS", () => {
    it("is a positive integer", () => {
      expect(DEFAULT_MAX_VIOLATIONS).toBeGreaterThan(0);
      expect(Number.isInteger(DEFAULT_MAX_VIOLATIONS)).toBe(true);
    });
  });
});
