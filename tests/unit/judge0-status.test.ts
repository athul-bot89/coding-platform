import { describe, it, expect } from "vitest";
import {
  statusLabel,
  isTerminalStatus,
  isAccepted,
  isFailed,
  isPending,
  JUDGE0_ACCEPTED,
  JUDGE0_IN_QUEUE,
  JUDGE0_PROCESSING,
  JUDGE0_WRONG_ANSWER,
  JUDGE0_TIME_LIMIT_EXCEEDED,
  JUDGE0_COMPILATION_ERROR,
  JUDGE0_INTERNAL_ERROR,
} from "@/lib/judge0-status";

describe("judge0-status", () => {
  describe("statusLabel", () => {
    it("returns 'Pending' for null/undefined/0", () => {
      expect(statusLabel(null)).toBe("Pending");
      expect(statusLabel(undefined)).toBe("Pending");
      expect(statusLabel(0)).toBe("Pending");
    });

    it("returns correct label for known statuses", () => {
      expect(statusLabel(JUDGE0_IN_QUEUE)).toBe("In Queue");
      expect(statusLabel(JUDGE0_PROCESSING)).toBe("Processing");
      expect(statusLabel(JUDGE0_ACCEPTED)).toBe("Accepted");
      expect(statusLabel(JUDGE0_WRONG_ANSWER)).toBe("Wrong Answer");
      expect(statusLabel(JUDGE0_TIME_LIMIT_EXCEEDED)).toBe("Time Limit Exceeded");
      expect(statusLabel(JUDGE0_COMPILATION_ERROR)).toBe("Compilation Error");
      expect(statusLabel(JUDGE0_INTERNAL_ERROR)).toBe("Internal Error");
    });

    it("returns 'Error' for unknown status codes", () => {
      expect(statusLabel(99)).toBe("Error");
      expect(statusLabel(200)).toBe("Error");
    });
  });

  describe("isTerminalStatus", () => {
    it("returns false for in-flight statuses", () => {
      expect(isTerminalStatus(JUDGE0_IN_QUEUE)).toBe(false);
      expect(isTerminalStatus(JUDGE0_PROCESSING)).toBe(false);
      expect(isTerminalStatus(null)).toBe(false);
      expect(isTerminalStatus(undefined)).toBe(false);
    });

    it("returns true for all verdicts", () => {
      expect(isTerminalStatus(JUDGE0_ACCEPTED)).toBe(true);
      expect(isTerminalStatus(JUDGE0_WRONG_ANSWER)).toBe(true);
      expect(isTerminalStatus(JUDGE0_TIME_LIMIT_EXCEEDED)).toBe(true);
      expect(isTerminalStatus(JUDGE0_COMPILATION_ERROR)).toBe(true);
      expect(isTerminalStatus(JUDGE0_INTERNAL_ERROR)).toBe(true);
    });
  });

  describe("isAccepted", () => {
    it("returns true only for status 3", () => {
      expect(isAccepted(JUDGE0_ACCEPTED)).toBe(true);
      expect(isAccepted(JUDGE0_WRONG_ANSWER)).toBe(false);
      expect(isAccepted(null)).toBe(false);
    });
  });

  describe("isFailed", () => {
    it("returns true for terminal non-accepted", () => {
      expect(isFailed(JUDGE0_WRONG_ANSWER)).toBe(true);
      expect(isFailed(JUDGE0_TIME_LIMIT_EXCEEDED)).toBe(true);
      expect(isFailed(JUDGE0_COMPILATION_ERROR)).toBe(true);
    });

    it("returns false for accepted and pending", () => {
      expect(isFailed(JUDGE0_ACCEPTED)).toBe(false);
      expect(isFailed(JUDGE0_IN_QUEUE)).toBe(false);
      expect(isFailed(null)).toBe(false);
    });
  });

  describe("isPending", () => {
    it("returns true for non-terminal states", () => {
      expect(isPending(JUDGE0_IN_QUEUE)).toBe(true);
      expect(isPending(JUDGE0_PROCESSING)).toBe(true);
      expect(isPending(null)).toBe(true);
    });

    it("returns false for verdicts", () => {
      expect(isPending(JUDGE0_ACCEPTED)).toBe(false);
      expect(isPending(JUDGE0_WRONG_ANSWER)).toBe(false);
    });
  });
});
