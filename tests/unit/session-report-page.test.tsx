// Renders the admin session report against a payload taken from a real sitting:
// ten questions, seventy-odd executions, two questions never opened, one written
// in but never submitted. A report is mostly arithmetic over awkward data — a
// question with no attempts, a draft with no submission, a run still grading —
// and every one of those shapes is in here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, within, cleanup, waitFor, fireEvent } from "@testing-library/react";
import fixture from "../fixtures/session-report.json";

const push = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: "admin" } }, status: "authenticated" }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "cmszzqmgl000213ucr8fg7vue" }),
  useRouter: () => ({ push }),
}));

import SessionReportPage from "@/app/admin/sessions/[id]/page";

const ATTEMPT_DETAIL = {
  id: "x",
  runs: [
    {
      id: "r1",
      ordinal: 1,
      kind: "sample",
      weight: 1,
      statusId: 4,
      exitCode: 0,
      timeS: 0.02,
      memoryKb: 3200,
      stdin: "5 3",
      expectedOutput: "8",
      stdout: "53",
      stderr: null,
      compileOutput: null,
      message: null,
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("/attempts/") ? ATTEMPT_DETAIL : fixture),
    }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

async function renderReport() {
  render(<SessionReportPage />);
  await screen.findByRole("heading", { level: 1 });
}

describe("session report page", () => {
  it("leads with who sat the test and how they did", async () => {
    await renderReport();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Farha Jebin");
    expect(screen.getByText("586/1000")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("shows estimated time on every question, including one never submitted", async () => {
    await renderReport();

    // 27 minutes across 32 markers — the question this candidate sank the test
    // into, and the one they still did not finish.
    // Once in the allocation legend at the top, once on the question card.
    expect(screen.getAllByText("27:18")).toHaveLength(2);
    // Touched once and never submitted: still time on the clock, still reported.
    expect(screen.getByText("one marker only")).toBeInTheDocument();
    // Two questions were never opened at all.
    expect(screen.getAllByText("never opened").length).toBeGreaterThanOrEqual(2);
  });

  it("says a question was written in but never submitted", async () => {
    await renderReport();
    // Two of them here: one touched once and abandoned, one run against the
    // samples and never submitted. Both score zero and neither is untouched.
    expect(screen.getAllByText(/Written but never submitted/)).toHaveLength(2);
  });

  it("distinguishes a question nobody touched from one that scored zero", async () => {
    await renderReport();
    expect(
      screen.getAllByText(/Never opened — no runs, no submissions, nothing typed/).length
    ).toBeGreaterThan(0);
  });

  it("opens a question's full history and then one attempt's test cases", async () => {
    await renderReport();

    // Prime Number Check: 18 submissions and 13 runs.
    fireEvent.click(screen.getByRole("button", { name: /Show full history \(31 executions\)/ }));

    const attempts = screen.getAllByRole("button", { expanded: false, name: /Submit|Run/ });
    expect(attempts.length).toBeGreaterThan(20);

    fireEvent.click(attempts[0]);
    expect(screen.getByText("Code as submitted")).toBeInTheDocument();
    expect(screen.getByText("Test cases")).toBeInTheDocument();

    // The per-case input and output is fetched only once a row is opened.
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/api/admin/attempts/"))
      ).toBe(true)
    );
  });

  it("shows a failed case's input, expected output and what actually came back", async () => {
    await renderReport();

    fireEvent.click(screen.getByRole("button", { name: /Show full history \(31 executions\)/ }));
    const attempts = screen.getAllByRole("button", { expanded: false, name: /Submit|Run/ });
    fireEvent.click(attempts[0]);

    const caseRow = await screen.findByRole("button", { name: /#1.*Wrong Answer/ });
    fireEvent.click(caseRow);

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Expected output")).toBeInTheDocument();
    expect(screen.getByText("Actual output")).toBeInTheDocument();
    expect(screen.getByText("53")).toBeInTheDocument();
  });

  it("groups the proctor log by event type before listing it", async () => {
    await renderReport();
    const proctor = screen.getByRole("region", { name: "Proctoring" });
    expect(within(proctor).getAllByText(/Connection lost|Reconnected/).length).toBeGreaterThan(0);
  });

  it("accounts for the whole window in the time allocation", async () => {
    await renderReport();
    const section = screen.getByRole("region", { name: "Where the time went" });
    // Every question with time on it appears in the legend.
    expect(within(section).getAllByText(/^Q\d+$/).length).toBe(8);
  });

  it("renders an error instead of a broken page when the report will not load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "Not found" }) }))
    );
    render(<SessionReportPage />);
    expect(await screen.findByText("Not found")).toBeInTheDocument();
  });
});
