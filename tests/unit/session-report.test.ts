import { describe, it, expect } from "vitest";
import {
  IDLE_CAP_MS,
  buildTimeBreakdown,
  codeChanged,
  tallyVerdicts,
} from "@/lib/session-report";

const MIN = 60_000;

describe("buildTimeBreakdown", () => {
  it("credits a gap to the question that closes it", () => {
    // Two minutes of thinking, then a run on Q1. The thinking belongs to Q1.
    const { byProblem } = buildTimeBreakdown([{ problemId: "q1", atMs: 2 * MIN }], 2 * MIN);
    expect(byProblem.get("q1")!.estimatedMs).toBe(2 * MIN);
  });

  it("splits the window across questions in the order they were worked on", () => {
    const { byProblem, unattributedMs } = buildTimeBreakdown(
      [
        { problemId: "q1", atMs: 1 * MIN },
        { problemId: "q1", atMs: 3 * MIN },
        { problemId: "q2", atMs: 6 * MIN },
        { problemId: "q2", atMs: 7 * MIN },
      ],
      8 * MIN
    );

    expect(byProblem.get("q1")!.estimatedMs).toBe(3 * MIN); // 0→3
    expect(byProblem.get("q2")!.estimatedMs).toBe(5 * MIN); // 3→7, plus the 1 min tail
    expect(unattributedMs).toBe(0);
  });

  it("caps any single gap and reports the excess as unattributed", () => {
    const { byProblem, unattributedMs } = buildTimeBreakdown(
      [{ problemId: "q1", atMs: 30 * MIN }],
      30 * MIN
    );
    expect(byProblem.get("q1")!.estimatedMs).toBe(IDLE_CAP_MS);
    expect(unattributedMs).toBe(30 * MIN - IDLE_CAP_MS);
  });

  it("credits the tail forwards to whatever was last worked on, capped", () => {
    const { byProblem, unattributedMs } = buildTimeBreakdown(
      [{ problemId: "q1", atMs: 1 * MIN }],
      40 * MIN
    );
    expect(byProblem.get("q1")!.estimatedMs).toBe(1 * MIN + IDLE_CAP_MS);
    expect(unattributedMs).toBe(40 * MIN - MIN - IDLE_CAP_MS);
  });

  it("records first and last touch and the marker count", () => {
    const { byProblem } = buildTimeBreakdown(
      [
        { problemId: "q1", atMs: 5 * MIN },
        { problemId: "q2", atMs: 2 * MIN },
        { problemId: "q1", atMs: 1 * MIN },
      ],
      6 * MIN
    );

    const q1 = byProblem.get("q1")!;
    expect(q1.firstTouchMs).toBe(1 * MIN);
    expect(q1.lastTouchMs).toBe(5 * MIN);
    expect(q1.markers).toBe(2);
  });

  it("attributes nothing when a session produced no activity", () => {
    const { byProblem, unattributedMs } = buildTimeBreakdown([], 10 * MIN);
    expect(byProblem.size).toBe(0);
    expect(unattributedMs).toBe(10 * MIN);
  });

  it("clamps markers that fall outside the window", () => {
    // A draft written during the finish request lands a moment past the buzzer,
    // and a burst carries a client-supplied offset that can be anything at all.
    const { byProblem, unattributedMs } = buildTimeBreakdown(
      [
        { problemId: "q1", atMs: -5000 },
        { problemId: "q1", atMs: 99 * MIN },
      ],
      2 * MIN
    );
    expect(byProblem.get("q1")!.estimatedMs).toBe(2 * MIN);
    expect(unattributedMs).toBe(0);
  });

  it("never attributes more than the window", () => {
    const markers = Array.from({ length: 50 }, (_, i) => ({
      problemId: `q${i % 5}`,
      atMs: i * 30_000,
    }));
    const window = 25 * MIN;
    const { byProblem, unattributedMs } = buildTimeBreakdown(markers, window);
    const total =
      Array.from(byProblem.values()).reduce((s, q) => s + q.estimatedMs, 0) + unattributedMs;
    expect(total).toBe(window);
  });
});

describe("tallyVerdicts", () => {
  it("separates passes, failures and work still in flight", () => {
    const t = tallyVerdicts([
      { statusId: 3 },
      { statusId: 3 },
      { statusId: 4 },
      { statusId: 5 },
      { statusId: 2 },
      { statusId: null },
    ]);
    expect(t).toMatchObject({ total: 6, passed: 2, failed: 2, pending: 2 });
    expect(t.byStatus).toEqual({ 2: 1, 3: 2, 4: 1, 5: 1 });
  });
});

describe("codeChanged", () => {
  it("ignores line endings and trailing whitespace", () => {
    expect(codeChanged("a = 1\nb = 2", "a = 1  \r\nb = 2\n\n")).toBe(false);
  });

  it("sees a real edit", () => {
    expect(codeChanged("a = 1", "a = 2")).toBe(true);
  });

  it("treats a missing side as different from code", () => {
    expect(codeChanged(null, "a = 1")).toBe(true);
    expect(codeChanged(null, "")).toBe(false);
  });
});
