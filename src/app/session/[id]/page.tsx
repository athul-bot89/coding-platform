"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CodeEditor, EditChange } from "@/components/CodeEditor";
import { getMonacoLanguage, languageName, defaultLanguageFor } from "@/lib/languages";
import { ProctorGuard } from "@/components/ProctorGuard";
import { FullscreenGate } from "@/components/FullscreenGate";
import { MultiDisplayGate } from "@/components/MultiDisplayGate";
import { TestTimer } from "@/components/TestTimer";
import { ConnectionBanner, SaveState, formatDuration } from "@/components/ConnectionBanner";
import { ResizeHandle } from "@/components/ResizeHandle";
import { EditorSettingsMenu } from "@/components/EditorSettingsMenu";
import { RulesDialog } from "@/components/RulesDialog";
import { useEditorLayout, DEFAULT_LAYOUT, NUDGE_PCT, NUDGE_PX } from "@/lib/editor-layout";
import { markdownToHtml } from "@/lib/markdown";
import { statusLabel, isAccepted, isFailed, JUDGE0_WRONG_ANSWER } from "@/lib/judge0-status";
import { fetchJson, postJson, HttpError, errorMessage } from "@/lib/fetch-json";
import {
  clearDrafts,
  dirtyDrafts,
  isDraftDirty,
  loadDrafts,
  markSynced,
  pruneDrafts,
  rememberDraft,
} from "@/lib/local-drafts";
import {
  HEARTBEAT_MS,
  DRAFT_SAVE_MS,
  METRICS_FLUSH_MS,
  BLOCKED_MESSAGES,
  BLOCKED_FALLBACK,
  OFFLINE_PROBE_MS,
  POLL_OFFLINE_BUDGET_MS,
  FINISH_ATTEMPTS,
  FINISH_RETRY_MS,
  isSilentEvent,
  violationLevel,
  VIOLATION_MESSAGES,
  VIOLATION_BADGES,
} from "@/lib/proctor-config";

/** Cadence of the grading poll, and how long it keeps asking before giving up. */
const POLL_INTERVAL_MS = 1500;
const POLL_BUDGET_MS = 90_000;

/** How often the banner's "offline for 2m 10s" and the save indicator re-render. */
const UI_TICK_MS = 1000;

/**
 * Questions are presented in two sections: the first five, then the rest.
 * Grouping only — every question stays reachable at any time, and nothing about
 * numbering, scoring, submission or the session payload changes with it.
 */
const SECTION_ONE_COUNT = 5;

interface SessionProblem {
  index: number;
  id: string;
  title: string;
  description: string;
  difficulty: string;
  points: number;
  allowedLanguages: number[];
  timeLimitMs: number;
  memoryLimitKb: number;
  starterCode: Record<string, string>;
  sampleTestCases: { ordinal: number; stdin: string; expectedOutput: string }[];
  totalTestCount: number;
  submissionCount: number;
  solved: boolean;
  attempted: boolean;
  draft: { code: string; languageId: number; savedAt: number } | null;
}

interface SessionData {
  id: string;
  title: string;
  /** Admin-authored markdown, repeated in the rules panel. */
  instructions: string | null;
  candidateName: string;
  remainingMs: number;
  startedAt: string;
  serverNow: number;
  violationCount: number;
  maxViolations: number;
  creditedMs: number;
  problems: SessionProblem[];
}

/** A proctor event that could not be sent when it happened. */
interface PendingEvent {
  event: string;
  detail?: string;
  /** Ms into the session, so the report puts it where it belongs. */
  atMs: number;
}

interface RunResult {
  id: string;
  kind: string;
  state: string;
  score: number;
  maxScore: number;
  runs: {
    ordinal: number;
    kind: string;
    statusId: number | null;
    stdout: string | null;
    stderr: string | null;
    compileOutput: string | null;
    stdin: string | null;
    expectedOutput: string | null;
    timeS: number | null;
    memoryKb: number | null;
  }[];
}

interface MetricBuffer {
  keystrokes: number;
  charsTyped: number;
  activeMs: number;
  largestInsertion: number;
  bursts: { atMs: number; chars: number }[];
}

export default function SessionPage() {
  const router = useRouter();
  const sessionId = useParams().id as string;

  const [data, setData] = useState<SessionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evicted, setEvicted] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editors, setEditors] = useState<Record<string, { code: string; languageId: number }>>({});
  const [results, setResults] = useState<Record<string, RunResult | null>>({});
  const [resultErrors, setResultErrors] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, "run" | "submit" | null>>({});
  const [violations, setViolations] = useState({ count: 0, max: 0 });
  const [deadline, setDeadline] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ending, setEnding] = useState(false);

  // ---- Connection state ----
  // `online` is what the last request actually did, not `navigator.onLine`, which
  // is true on a captive portal and on a laptop connected to a router with no
  // route out. A failed request is the only proof that matters.
  const [online, setOnline] = useState(true);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  const [queuedSubmits, setQueuedSubmits] = useState<string[]>([]);
  const [creditedMs, setCreditedMs] = useState(0);
  const [justCreditedMs, setJustCreditedMs] = useState<number | null>(null);
  /** The countdown hit zero while offline; the server has not confirmed the end. */
  const [awaitingServer, setAwaitingServer] = useState(false);
  const [uiNow, setUiNow] = useState(() => Date.now());

  const tabId = useMemo(
    () => Math.random().toString(36).slice(2) + Date.now().toString(36),
    []
  );

  // ---- Panel sizing -------------------------------------------------------
  const { layout, set: setLayout, reset: resetLayout } = useEditorLayout();
  /** The row holding the rail, the problem panel and the editor column. */
  const rowRef = useRef<HTMLDivElement>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  const dragSplit = useCallback(
    (clientX: number) => {
      const row = rowRef.current;
      const panel = problemRef.current;
      if (!row || !panel) return;
      const rowWidth = row.getBoundingClientRect().width;
      if (rowWidth <= 0) return;
      // Measured from the panel's own left edge rather than the row's: the
      // question rail sits between them, and its width must not be counted as
      // problem-panel width or the panel would trail the cursor by 64px.
      const left = panel.getBoundingClientRect().left;
      setLayout({ splitPct: ((clientX - left) / rowWidth) * 100 });
    },
    [setLayout]
  );

  const dragResults = useCallback(
    (_clientX: number, clientY: number) => {
      const column = columnRef.current;
      if (!column) return;
      const rect = column.getBoundingClientRect();
      // The drawer grows upward, and is not allowed to push the editor below a
      // usable height however far the pointer travels.
      setLayout({ resultsPx: Math.min(rect.bottom - clientY, rect.height - 160) });
    },
    [setLayout]
  );

  const startedAt = useRef(Date.now());
  const metrics = useRef<Record<string, MetricBuffer>>({});
  const lastEditAt = useRef<Record<string, number>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const endingRef = useRef(false);
  const unmounted = useRef(false);
  // Heartbeat state, read from refs so the interval never has to be rebuilt.
  const sessionReady = useRef(false);
  const evictedRef = useRef(false);
  const onlineRef = useRef(true);
  const offlineSinceRef = useRef<number | null>(null);
  /** Events that happened while the connection was down, oldest first. */
  const pendingEvents = useRef<PendingEvent[]>([]);
  /** problemId → the kind of run waiting to be sent once the connection is back. */
  const queuedRef = useRef<Record<string, "run" | "submit">>({});
  const flushingDrafts = useRef(false);
  /** Latest `execute`, so a queued submission can be fired from a stable callback. */
  const executeRef = useRef<((p: SessionProblem, kind: "run" | "submit") => void) | null>(null);
  const problemsRef = useRef<SessionProblem[]>([]);
  /** Editors as they stand, readable without making a state updater do the work. */
  const editorsRef = useRef<Record<string, { code: string; languageId: number }>>({});

  const problems = data?.problems ?? [];
  const active = problems[activeIdx];
  problemsRef.current = problems;
  editorsRef.current = editors;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  // ---- Connection ----------------------------------------------------------

  /** Ms into the session, for stamping an event that is reported late. */
  const sessionOffsetMs = useCallback(
    () => Math.max(0, Date.now() - startedAt.current),
    []
  );

  const noteOffline = useCallback(() => {
    if (!onlineRef.current) return;
    onlineRef.current = false;
    const at = Date.now();
    offlineSinceRef.current = at;
    setOnline(false);
    setOfflineSince(at);
    setJustCreditedMs(null);
    // Cannot be reported now, by definition. Queued with the moment it happened
    // so the report shows the outage where it actually fell.
    pendingEvents.current.push({ event: "connection_lost", atMs: sessionOffsetMs() });
  }, [sessionOffsetMs]);

  const noteOnline = useCallback(() => {
    if (onlineRef.current) return;
    onlineRef.current = true;
    const downMs = offlineSinceRef.current ? Date.now() - offlineSinceRef.current : 0;
    offlineSinceRef.current = null;
    setOnline(true);
    setOfflineSince(null);

    // How long it lasted is only knowable now, so it is written onto the queued
    // "lost" event rather than the "restored" one — the report reads better with
    // the duration next to the disconnection it describes.
    const lost = pendingEvents.current.find((e) => e.event === "connection_lost" && !e.detail);
    if (lost) lost.detail = `offline for ${formatDuration(downMs)}`;

    pendingEvents.current.push({ event: "connection_restored", atMs: sessionOffsetMs() });
  }, [sessionOffsetMs]);

  /** True for a failure that means "the request never got there". */
  const isNetworkError = (err: unknown) => !(err instanceof HttpError);

  // The grading poll reschedules itself, so it has to be told when the screen is
  // gone; otherwise it keeps firing — and keeps setting state — long after
  // `router.replace` has sent the candidate to the completion page.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      for (const timer of Object.values(pollTimers.current)) clearTimeout(timer);
    };
  }, []);

  // ---- Draft persistence ----------------------------------------------------
  //
  // Two layers, because the network is not one of them. Every edit is mirrored to
  // this device synchronously; a single flusher re-sends whatever the server has
  // not acknowledged. An outage, a 500 or a sleeping laptop then costs a delay
  // instead of code.

  const refreshDirty = useCallback(() => {
    setUnsyncedCount(dirtyDrafts(sessionId).length);
  }, [sessionId]);

  const mirrorDraft = useCallback(
    (problemId: string, code: string, languageId: number) => {
      if (!rememberDraft(sessionId, problemId, code, languageId)) setLocalSaveFailed(true);
      refreshDirty();
    },
    [sessionId, refreshDirty]
  );

  const flushDrafts = useCallback(async () => {
    // Serialised rather than skipped: `endTest` awaits this to get the last
    // keystrokes onto the server, and a caller that gave up because the periodic
    // pass happened to be mid-flight would be awaiting nothing. Bounded, so a
    // hung request cannot hold up the end of a test.
    for (let waited = 0; flushingDrafts.current && waited < 2_000; waited += 50) {
      await sleep(50);
    }
    if (flushingDrafts.current) return;

    const dirty = dirtyDrafts(sessionId);
    if (dirty.length === 0) {
      setUnsyncedCount(0);
      return;
    }

    flushingDrafts.current = true;
    try {
      for (const { problemId, draft } of dirty) {
        try {
          await postJson(`/api/session/${sessionId}/draft`, {
            problemId,
            code: draft.code,
            languageId: draft.languageId,
          });
          // Acknowledged against the `savedAt` that was actually sent, so an edit
          // made while this was in flight stays dirty and goes in the next pass.
          markSynced(sessionId, problemId, draft.savedAt);
          setLastSyncedAt(Date.now());
          noteOnline();
        } catch (err) {
          if (isNetworkError(err)) {
            // Nothing is getting through; stop trying the rest and let the next
            // pass pick all of them up together.
            noteOffline();
            break;
          }
          noteOnline();
          // A 400 is a draft this server will never accept — a question pulled
          // from the test mid-run. Retrying it forever would block every other
          // problem's save behind it, and the local copy is untouched either way.
          if (err instanceof HttpError && err.status === 400) {
            markSynced(sessionId, problemId, draft.savedAt);
          }
          // The test is over; the heartbeat is already redirecting.
          if (err instanceof HttpError && err.body?.ended) break;
        }
      }
    } finally {
      flushingDrafts.current = false;
      refreshDirty();
    }
  }, [sessionId, noteOnline, noteOffline, refreshDirty]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!endingRef.current) flushDrafts();
    }, DRAFT_SAVE_MS);
    return () => clearInterval(id);
  }, [flushDrafts]);

  // Last-gasp save when the page goes away. `keepalive` is what lets these outlive
  // the document — a plain fetch is cancelled as the tab closes, which is exactly
  // the moment the unsent draft matters most.
  useEffect(() => {
    const flushNow = () => {
      for (const { problemId, draft } of dirtyDrafts(sessionId)) {
        fetch(`/api/session/${sessionId}/draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problemId, code: draft.code, languageId: draft.languageId }),
          keepalive: true,
        }).catch(() => {});
      }
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushNow();
    };

    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [sessionId]);

  // ---- Ending the test ------------------------------------------------------

  const endTest = useCallback(
    async (reason: "manual" | "timeout" | "terminated") => {
      if (endingRef.current) return;
      endingRef.current = true;
      setEnding(true);

      // Whatever is still only on this device goes first, before the screen that
      // holds it is torn down.
      await flushDrafts();

      let confirmed = reason === "terminated";

      for (let attempt = 1; attempt <= FINISH_ATTEMPTS && !confirmed; attempt++) {
        try {
          await postJson(`/api/session/${sessionId}/finish`, { reason });
          noteOnline();
          confirmed = true;
        } catch (err) {
          if (!isNetworkError(err)) {
            // The server answered — including "already finished". Either way it
            // knows, so there is nothing to retry.
            noteOnline();
            confirmed = true;
            break;
          }
          noteOffline();
          if (attempt < FINISH_ATTEMPTS) await sleep(FINISH_RETRY_MS * attempt);
        }
      }

      // A candidate who pressed Finish while their connection was down has not
      // finished anything — the server never heard it. Sending them to the
      // completion screen would strand a test that is still running and still has
      // time on it, so keep them in it and say why.
      if (!confirmed && reason === "manual") {
        endingRef.current = false;
        setEnding(false);
        setConfirmFinish(false);
        flash(
          "Couldn't reach the server to finish your test. Your work is saved — check your connection and try again."
        );
        return;
      }

      // The server has it all, so the local mirror has no job left. Left in place
      // when the finish was never confirmed: it is the only copy of that code.
      if (confirmed) clearDrafts(sessionId);

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      router.replace(`/session/${sessionId}/complete?reason=${reason}`);
    },
    [sessionId, router, flushDrafts, flash, noteOnline, noteOffline]
  );

  // ---- Proctor events -------------------------------------------------------

  const reportEvent = useCallback(
    async (event: string, detail?: string) => {
      try {
        const body = await postJson(`/api/session/${sessionId}/event`, { event, detail });
        noteOnline();

        setViolations({ count: body.violationCount, max: body.maxViolations });

        if (body.terminated) {
          flash("Too many violations — your test has been submitted.");
          endTest("terminated");
          return;
        }

        // The server decides what counts; the message follows that, so a blocked
        // action is never dressed up as a warning. Connection events are logged
        // for the report and say nothing to the candidate — the banner is already
        // telling them what they need to know.
        if (!body.counted) {
          if (!isSilentEvent(event)) flash(BLOCKED_MESSAGES[event] ?? BLOCKED_FALLBACK);
        } else if (event !== "fullscreen_exit") {
          // The fullscreen overlay says this itself, in its own copy.
          // No tally here — see the note above VIOLATION_MESSAGES.
          const level = violationLevel(body.violationCount, body.maxViolations);
          if (level !== "none") flash(VIOLATION_MESSAGES[level]);
        }
      } catch (err) {
        // Never let a logging failure interfere with the test — but do not let an
        // outage erase the log either. A violation that happened is a violation,
        // so it is held with the moment it happened and sent on reconnect.
        if (isNetworkError(err)) {
          noteOffline();
          pendingEvents.current.push({ event, detail, atMs: sessionOffsetMs() });
        }
      }
    },
    [sessionId, flash, endTest, noteOnline, noteOffline, sessionOffsetMs]
  );

  /** Send what the outage held back, oldest first, stopping if it drops again. */
  const flushPendingEvents = useCallback(async () => {
    while (pendingEvents.current.length > 0 && onlineRef.current) {
      const next = pendingEvents.current[0];
      try {
        const body = await postJson(`/api/session/${sessionId}/event`, next);
        pendingEvents.current.shift();
        setViolations({ count: body.violationCount, max: body.maxViolations });
        // A violation that happened during an outage is still a violation the
        // candidate has to be told about — otherwise the only notice they get
        // is the auto-submit. Flushing several in a row settles on the last
        // message, which is the most severe, so that is the right one to leave up.
        if (body.counted) {
          const level = violationLevel(body.violationCount, body.maxViolations);
          if (level !== "none") flash(VIOLATION_MESSAGES[level]);
        }
        if (body.terminated) {
          flash("Too many violations — your test has been submitted.");
          endTest("terminated");
          return;
        }
      } catch (err) {
        if (isNetworkError(err)) {
          noteOffline();
          return;
        }
        // The server rejected it. Dropping it is the only way not to spin here.
        pendingEvents.current.shift();
      }
    }
  }, [sessionId, flash, endTest, noteOffline]);

  // ---- Load ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/session/${sessionId}?tabId=${tabId}`);
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          if (body.ended) {
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
            return;
          }
          setLoadError(body.error || "Could not load this test.");
          return;
        }

        const payload = body as SessionData;
        setData(payload);
        sessionReady.current = true;
        setViolations({ count: payload.violationCount, max: payload.maxViolations });
        setDeadline(Date.now() + payload.remainingMs);
        setCreditedMs(payload.creditedMs ?? 0);

        // Anchor the session's own timeline to this clock, so an event reported
        // late lands where it happened even after a reload. Measured through the
        // server's `now` rather than trusting this machine's absolute time.
        const startedAtMs = new Date(payload.startedAt).getTime();
        if (Number.isFinite(startedAtMs) && Number.isFinite(payload.serverNow)) {
          startedAt.current = Date.now() - Math.max(0, payload.serverNow - startedAtMs);
        }

        // Forget mirrors for questions this session is no longer serving, so the
        // flusher stops re-sending drafts the server now rejects.
        pruneDrafts(
          sessionId,
          payload.problems.map((p) => p.id)
        );
        const local = loadDrafts(sessionId);

        const initial: Record<string, { code: string; languageId: number }> = {};
        let restored = 0;
        for (const p of payload.problems) {
          const mine = local[p.id];

          // A local draft the server never acknowledged is, by construction, work
          // typed while the connection was down — so it wins over whatever the
          // server last managed to store. Only the two client-clock stamps are
          // compared, so a skewed clock cannot make it look stale.
          if (isDraftDirty(mine)) {
            initial[p.id] = { code: mine.code, languageId: mine.languageId };
            restored += 1;
            continue;
          }

          const langId = p.draft?.languageId ?? defaultLanguageFor(p.allowedLanguages);
          initial[p.id] = {
            languageId: langId,
            code: p.draft?.code ?? p.starterCode[String(langId)] ?? "",
          };
        }
        setEditors(initial);
        refreshDirty();

        if (restored > 0) {
          flash(
            `Restored unsaved code for ${restored} question${restored === 1 ? "" : "s"} from this device.`
          );
        }
      } catch {
        if (!cancelled) setLoadError("Network error while loading the test.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, tabId, router, flash, refreshDirty]);

  // ---- Heartbeat: clock re-sync, reconnect detection, tab eviction ----------

  // Established once, on mount, and gated on refs rather than on `data`. Listing
  // `data` here restarted the interval on every submission — `execute` replaces
  // the payload to bump submissionCount — so a candidate submitting faster than
  // HEARTBEAT_MS never completed a tick and never beat at all: stale lastSeenAt,
  // no clock re-sync, and no duplicate-tab eviction.
  //
  // Self-scheduling rather than a fixed interval, because the cadence changes:
  // while the connection is down this is also the thing that notices it come back,
  // and every probe that fails is a probe that could have restored the candidate's
  // time a few seconds sooner.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const beat = async () => {
      if (!sessionReady.current || evictedRef.current || endingRef.current) return;

      try {
        const body = await postJson(`/api/session/${sessionId}/heartbeat`, { tabId });
        noteOnline();

        // The server clock is the only one that matters — and it is the clock that
        // has already had any offline time added back to it.
        setDeadline(Date.now() + body.remainingMs);
        setViolations({ count: body.violationCount, max: body.maxViolations });
        setCreditedMs(body.creditedMs ?? 0);

        if (body.grantedMs > 0) {
          setJustCreditedMs(body.grantedMs);
          flash(
            `Back online — ${formatDuration(body.grantedMs)} of lost time was added back to your clock.`
          );
        }

        setAwaitingServer(false);

        // Nothing left, and the server is the one saying so. Ends the test for a
        // tab whose own countdown was paused waiting for exactly this answer.
        if (body.remainingMs <= 0) endTest("timeout");
      } catch (err) {
        if (err instanceof HttpError) {
          // The server answered, so the connection is fine.
          noteOnline();
          if (err.status === 409 && err.body?.evicted) {
            evictedRef.current = true;
            setEvicted(true);
            return;
          }
          if (err.body?.ended && !endingRef.current) {
            endingRef.current = true;
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
          }
          return;
        }
        noteOffline();
      }
    };

    const loop = async () => {
      await beat();
      if (stopped) return;
      timer = setTimeout(loop, onlineRef.current ? HEARTBEAT_MS : OFFLINE_PROBE_MS);
    };

    timer = setTimeout(loop, HEARTBEAT_MS);

    // The browser reporting an interface back is worth acting on straight away
    // rather than waiting out a probe interval. It is only a hint — the beat is
    // what decides — so nothing here marks the connection up.
    const probeNow = () => {
      if (stopped) return;
      clearTimeout(timer);
      loop();
    };

    window.addEventListener("online", probeNow);
    window.addEventListener("offline", noteOffline);

    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", probeNow);
      window.removeEventListener("offline", noteOffline);
    };
  }, [sessionId, tabId, router, flash, noteOnline, noteOffline, endTest]);

  // Counts up the outage in the banner. Deliberately only while offline: a ticker
  // running for the whole test would re-render the editor's parent every second
  // for no one's benefit.
  useEffect(() => {
    if (online) return;
    setUiNow(Date.now());
    const id = setInterval(() => setUiNow(Date.now()), UI_TICK_MS);
    return () => clearInterval(id);
  }, [online]);

  // The "time was added back" banner is news, not status; it steps aside once read.
  useEffect(() => {
    if (justCreditedMs === null) return;
    const id = setTimeout(() => setJustCreditedMs(null), 12_000);
    return () => clearTimeout(id);
  }, [justCreditedMs]);

  // ---- Typing metrics -------------------------------------------------------

  const flushMetrics = useCallback(
    (problemId?: string) => {
      const ids = problemId ? [problemId] : Object.keys(metrics.current);
      for (const id of ids) {
        const buf = metrics.current[id];
        if (!buf || (buf.keystrokes === 0 && buf.bursts.length === 0)) continue;

        // The window is swapped out rather than cleared, so keystrokes landing
        // while the POST is in flight accumulate in the fresh buffer and can't be
        // sent twice. If the POST never lands the unsent window is merged back:
        // an offline blip must not silently erase a window's paste evidence.
        metrics.current[id] = emptyBuffer();
        postJson(`/api/session/${sessionId}/metrics`, { problemId: id, ...buf })
          .then(() => noteOnline())
          .catch((err) => {
            if (isNetworkError(err)) noteOffline();
            mergeBuffer((metrics.current[id] ||= emptyBuffer()), buf);
          });
      }
    },
    [sessionId, noteOnline, noteOffline]
  );

  useEffect(() => {
    const id = setInterval(() => flushMetrics(), METRICS_FLUSH_MS);
    return () => clearInterval(id);
  }, [flushMetrics]);

  const handleEdit = useCallback((problemId: string, change: EditChange) => {
    const buf = (metrics.current[problemId] ||= emptyBuffer());
    const now = Date.now();

    buf.keystrokes += 1;
    buf.charsTyped += change.chars;
    buf.largestInsertion = Math.max(buf.largestInsertion, change.chars);

    // Only count gaps under 5s as active typing; anything longer is thinking
    // time (or time away) and shouldn't inflate the effort estimate.
    const gap = now - (lastEditAt.current[problemId] ?? now);
    if (gap > 0 && gap < 5000) buf.activeMs += gap;
    lastEditAt.current[problemId] = now;

    if (change.isBurst) {
      buf.bursts.push({ atMs: now - startedAt.current, chars: change.chars });
    }
  }, []);

  // ---- Editing --------------------------------------------------------------

  // The mirror runs here rather than inside the state updater it used to sit in:
  // writing storage and setting the unsaved count are effects, and an updater has
  // to stay a pure function of the previous state — React is free to call it twice.
  const updateCode = useCallback(
    (problemId: string, code: string) => {
      const cur = editorsRef.current[problemId];
      if (!cur || cur.code === code) return;

      // Mirrored on this keystroke, not on a timer: the debounce belongs to the
      // network save, and the local copy is what makes an outage survivable.
      mirrorDraft(problemId, code, cur.languageId);
      setEditors((prev) => ({ ...prev, [problemId]: { ...prev[problemId], code } }));
    },
    [mirrorDraft]
  );

  const changeLanguage = useCallback(
    (problem: SessionProblem, languageId: number) => {
      const cur = editorsRef.current[problem.id];
      const untouched =
        !cur?.code?.trim() || cur.code === problem.starterCode[String(cur.languageId)];
      const code = untouched ? problem.starterCode[String(languageId)] ?? "" : cur?.code ?? "";

      mirrorDraft(problem.id, code, languageId);
      setEditors((prev) => ({ ...prev, [problem.id]: { code, languageId } }));
    },
    [mirrorDraft]
  );

  /**
   * Throw away the current buffer and put the starter template for the language
   * back. Deliberately not routed through `updateCode`: that one bails when the
   * text is unchanged, and a reset has to mirror the draft even then so the
   * stored copy can never survive a reset the editor already shows.
   */
  const resetCode = useCallback(
    (problem: SessionProblem) => {
      const languageId =
        editorsRef.current[problem.id]?.languageId ?? defaultLanguageFor(problem.allowedLanguages);
      const code = problem.starterCode[String(languageId)] ?? "";

      mirrorDraft(problem.id, code, languageId);
      setEditors((prev) => ({ ...prev, [problem.id]: { code, languageId } }));
    },
    [mirrorDraft]
  );

  const switchQuestion = useCallback(
    (index: number) => {
      if (active) flushMetrics(active.id);
      setActiveIdx(index);
    },
    [active, flushMetrics]
  );

  // ---- Run / Submit ---------------------------------------------------------

  const execute = useCallback(
    async (problem: SessionProblem, kind: "run" | "submit") => {
      if (busy[problem.id]) return;
      const editor = editors[problem.id];
      if (!editor?.code.trim()) {
        flash("Write some code first.");
        return;
      }

      // Superseded by this run, whether it was queued a moment ago or is being
      // fired by the reconnect flush right now.
      delete queuedRef.current[problem.id];
      setQueuedSubmits(Object.keys(queuedRef.current));

      setBusy((b) => ({ ...b, [problem.id]: kind }));
      setResults((r) => ({ ...r, [problem.id]: null }));
      setResultErrors((e) => ({ ...e, [problem.id]: null }));
      flushMetrics(problem.id);

      const giveUp = (message: string) => {
        setBusy((b) => ({ ...b, [problem.id]: null }));
        setResultErrors((e) => ({ ...e, [problem.id]: message }));
      };

      let body: { attemptId: string };
      try {
        body = await postJson(`/api/session/${sessionId}/submit`, {
          problemId: problem.id,
          languageId: editor.languageId,
          sourceCode: editor.code,
          kind,
        });
        noteOnline();
      } catch (err) {
        setBusy((b) => ({ ...b, [problem.id]: null }));

        if (isNetworkError(err)) {
          // The submission never left the building. Hold it and fire it the moment
          // the connection is back, so a candidate who pressed Submit into a dead
          // network does not have to notice, remember, and press it again.
          noteOffline();
          queuedRef.current[problem.id] = kind;
          setQueuedSubmits(Object.keys(queuedRef.current));
          setResultErrors((e) => ({
            ...e,
            [problem.id]:
              "You're offline, so this hasn't been sent yet. It goes automatically the moment your connection is back — your code is saved either way.",
          }));
          return;
        }

        noteOnline();
        if (err instanceof HttpError) {
          if (err.body?.ended && !endingRef.current) {
            endingRef.current = true;
            router.replace(`/session/${sessionId}/complete?reason=timeout`);
            return;
          }
          flash(errorMessage(err, "Submission failed."));
        }
        return;
      }

      try {
        let pollUntil = Date.now() + POLL_BUDGET_MS;
        let offlineWaitedMs = 0;

        const poll = async () => {
          if (unmounted.current || endingRef.current) return;

          try {
            // fetchJson throws on a non-2xx. Storing the parsed body unchecked used
            // to turn an expired cookie into `{ error: "Unauthorized" }` sitting in
            // `results`, which stopped the polling and then took the whole test
            // screen down the moment the panel tried to read `.runs` off it.
            const result = await fetchJson<RunResult>(`/api/attempts/${body.attemptId}`);
            if (unmounted.current || endingRef.current) return;
            noteOnline();

            setResults((prev) => ({ ...prev, [problem.id]: result }));

            if (result.state === "running" || result.state === "queued") {
              // Judge0 can leave an attempt running indefinitely; polling for the
              // rest of the test only burns requests. Whatever is still in flight is
              // drained server-side when the session is finalized.
              if (Date.now() > pollUntil) {
                giveUp(
                  "Still grading — this is taking longer than usual. Your submission is saved and will still be scored; you can keep working."
                );
                return;
              }
              pollTimers.current[problem.id] = setTimeout(poll, POLL_INTERVAL_MS);
              return;
            }

            setBusy((b) => ({ ...b, [problem.id]: null }));

            if (kind === "submit") {
              const passed = result.maxScore > 0 && result.score === result.maxScore;
              setData((d) =>
                d
                  ? {
                      ...d,
                      problems: d.problems.map((p) =>
                        p.id === problem.id
                          ? {
                              ...p,
                              submissionCount: p.submissionCount + 1,
                              attempted: true,
                              solved: p.solved || passed,
                            }
                          : p
                      ),
                    }
                  : d
              );
            }
          } catch (err) {
            if (unmounted.current || endingRef.current) return;

            if (isNetworkError(err)) {
              // The attempt is already on the server and is being graded whether
              // this tab can see it or not. Losing the connection while watching is
              // not a failed submission, so keep waiting — and do not spend the
              // grading budget on time the network was down.
              noteOffline();
              if (offlineWaitedMs < POLL_OFFLINE_BUDGET_MS) {
                offlineWaitedMs += OFFLINE_PROBE_MS;
                pollUntil += OFFLINE_PROBE_MS;
                pollTimers.current[problem.id] = setTimeout(poll, OFFLINE_PROBE_MS);
                return;
              }
            }

            giveUp(gradingError(err));
          }
        };

        clearTimeout(pollTimers.current[problem.id]);
        pollTimers.current[problem.id] = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        setBusy((b) => ({ ...b, [problem.id]: null }));
        flash("Network error.");
      }
    },
    [busy, editors, sessionId, flash, flushMetrics, router, noteOnline, noteOffline]
  );

  executeRef.current = execute;

  /**
   * Fire everything that was waiting on the network. Reads the editor as it stands
   * now rather than the copy that was queued — the candidate may have kept typing
   * through the outage, and the newer code is the one they meant to submit.
   */
  const flushQueuedSubmits = useCallback(() => {
    const queued = Object.entries(queuedRef.current);
    if (queued.length === 0) return;
    queuedRef.current = {};
    setQueuedSubmits([]);

    for (const [problemId, kind] of queued) {
      const problem = problemsRef.current.find((p) => p.id === problemId);
      if (problem) executeRef.current?.(problem, kind);
    }
  }, []);

  // Reconnected: send what the outage held back, in the order that matters — the
  // record of what happened, then the code, then anything mid-flight. Also runs on
  // mount, which is what re-sends a draft left unsynced by a previous page load.
  useEffect(() => {
    if (!online) return;
    flushPendingEvents();
    flushDrafts();
    flushMetrics();
    flushQueuedSubmits();
  }, [online, flushPendingEvents, flushDrafts, flushMetrics, flushQueuedSubmits]);

  const handleExpire = useCallback(() => {
    flushMetrics();

    // A countdown reaching zero on a machine with no connection proves nothing.
    // The server may be about to hand this exact time back as offline credit, so
    // closing the test here would take away the minutes the credit is meant to
    // restore. Wait for the server to say it is over; the probe loop is asking
    // every few seconds, and it ends the test the moment the answer is no time
    // left. Their code is already mirrored and queued either way.
    if (!onlineRef.current) {
      setAwaitingServer(true);
      return;
    }

    endTest("timeout");
  }, [flushMetrics, endTest]);

  // ---- Non-test states ------------------------------------------------------

  if (evicted) {
    return (
      <Centered>
        <div className="text-4xl mb-4">🪟</div>
        <h1 className="text-xl font-semibold mb-2">Opened in another window</h1>
        <p className="text-sm text-gray-400">
          This test is now running in a different tab. Only one window can be open at a time —
          continue in the newest one.
        </p>
      </Centered>
    );
  }

  if (loadError) {
    return (
      <Centered>
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold mb-2">Can&apos;t open this test</h1>
        <p className="text-sm text-gray-400">{loadError}</p>
      </Centered>
    );
  }

  if (!data || deadline === null) {
    return (
      <Centered>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500 mx-auto" />
      </Centered>
    );
  }

  // The payload loaded but there is no question to show — an assessment with its
  // problems removed, or an index that no longer exists. A spinner here would pin
  // the candidate for the rest of their timed test with no way out, so say what
  // happened and leave the exit open.
  if (!active) {
    return (
      <Centered>
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold mb-2">No question to show</h1>
        <p className="text-sm text-gray-400 mb-2">
          {problems.length === 0
            ? "This test has no questions assigned to it, so there is nothing here to solve."
            : "The question you were on is no longer part of this test."}
        </p>
        <p className="text-sm text-gray-400 mb-5">
          This is not something you did — please tell whoever invited you. You can finish now
          instead of waiting out the clock.
        </p>
        <div className="flex gap-3">
          {problems.length > 0 && (
            <button
              onClick={() => setActiveIdx(0)}
              className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
            >
              Back to question 1
            </button>
          )}
          <button
            onClick={() => {
              flushMetrics();
              endTest("manual");
            }}
            disabled={ending}
            className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700 disabled:opacity-50"
          >
            {ending ? "Submitting…" : "Finish test"}
          </button>
        </div>
      </Centered>
    );
  }

  const editor = editors[active.id] ?? {
    code: "",
    languageId: defaultLanguageFor(active.allowedLanguages),
  };
  const result = results[active.id];
  const resultError = resultErrors[active.id] ?? null;
  const activeBusy = busy[active.id];
  const solvedCount = problems.filter((p) => p.solved).length;
  // A test short enough to fit in one section is not a sectioned test, so the
  // headers and the "Section 1 · Question 2" line stay out of the way entirely.
  const sections = toSections(problems);
  const sectioned = sections.length > 1;
  // Tone only — the tally behind it is never rendered.
  const violationBadgeLevel = violationLevel(violations.count, violations.max);

  return (
    <>
      <ProctorGuard onEvent={reportEvent} enabled={!ending} />

      <MultiDisplayGate>
      <FullscreenGate violationCount={violations.count} maxViolations={violations.max}>
        <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden no-select">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="font-semibold truncate">{data.title}</h1>
              <span className="text-xs text-gray-500 shrink-0">{data.candidateName}</span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <SaveState
                online={online}
                unsyncedCount={unsyncedCount}
                hasSaved={lastSyncedAt !== null}
              />
              {violations.max > 0 && violationBadgeLevel !== "none" && (
                <span
                  className={`text-xs px-2 py-1 rounded border ${
                    violationBadgeLevel === "noted"
                      ? "bg-amber-950 text-amber-300 border-amber-900"
                      : "bg-red-950 text-red-300 border-red-900"
                  }`}
                >
                  ⚠ {VIOLATION_BADGES[violationBadgeLevel]}
                </span>
              )}
              <div className="flex flex-col items-end gap-0.5">
                <TestTimer deadline={deadline} onExpire={handleExpire} />
                {creditedMs > 0 && (
                  <span
                    className="text-[10px] text-green-400"
                    title="Time added back for connection problems"
                  >
                    +{formatDuration(creditedMs)} restored
                  </span>
                )}
              </div>
              <button
                onClick={() => setConfirmFinish(true)}
                disabled={ending}
                className="px-4 py-2 bg-red-600 rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                Finish test
              </button>
            </div>
          </header>

          <ConnectionBanner
            online={online}
            offlineSince={offlineSince}
            now={uiNow}
            unsyncedCount={unsyncedCount}
            queuedCount={queuedSubmits.length}
            creditedMs={creditedMs}
            justCreditedMs={justCreditedMs}
            awaitingServer={awaitingServer}
            localSaveFailed={localSaveFailed}
          />

          <div ref={rowRef} className="flex flex-1 overflow-hidden">
            {/* Question rail */}
            <nav className="w-16 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-3 gap-2 shrink-0 overflow-y-auto">
              {sections.map((section) => (
                <div key={section.title} className="w-full flex flex-col items-center gap-2">
                  {/* The rail is 64px wide, so the header is abbreviated and the
                      full name lives in the tooltip and the problem panel. */}
                  {sectioned && (
                    <div className="w-full px-2.5 pt-1" title={section.title}>
                      <div className="text-[9px] font-semibold uppercase tracking-widest text-gray-500 text-center">
                        {section.short}
                      </div>
                      <div className="mt-1 border-t border-gray-800" />
                    </div>
                  )}
                  {section.items.map((p, i) => {
                    // Numbering stays continuous across sections, so Q4 is the
                    // fourth question of the test rather than the first of S2.
                    const index = section.offset + i;
                    return (
                      <button
                        key={p.id}
                        onClick={() => switchQuestion(index)}
                        title={`${sectioned ? `${section.title} — ` : ""}${p.title} — ${p.points} pts`}
                        className={`w-11 h-11 rounded-lg text-sm font-semibold border transition-colors relative shrink-0 ${
                          index === activeIdx
                            ? "bg-green-600 border-green-500 text-white"
                            : p.solved
                            ? "bg-green-950 border-green-800 text-green-400 hover:bg-green-900"
                            : p.attempted
                            ? "bg-gray-800 border-yellow-800 text-yellow-400 hover:bg-gray-700"
                            : "bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700"
                        }`}
                      >
                        Q{index + 1}
                        {p.solved && index !== activeIdx && (
                          <span className="absolute -top-1 -right-1 text-[10px] bg-green-600 rounded-full w-4 h-4 flex items-center justify-center">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="mt-auto pt-3 text-[10px] text-gray-600 text-center leading-tight shrink-0">
                {solvedCount}/{problems.length}
                <br />
                solved
              </div>
            </nav>

            {/* Problem statement */}
            <div
              ref={problemRef}
              style={{ width: `${layout.splitPct}%` }}
              className="shrink-0 overflow-y-auto p-4"
            >
              {sectioned && (
                <div className="text-xs text-gray-500 mb-1">
                  {sectionTitleFor(activeIdx)} · Question {activeIdx + 1} of {problems.length}
                </div>
              )}

              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-lg font-semibold">{active.title}</h2>
                <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400">
                  {active.points} pts
                </span>
                <span
                  className={`text-xs ${
                    active.difficulty === "easy"
                      ? "text-green-400"
                      : active.difficulty === "hard"
                      ? "text-red-400"
                      : "text-yellow-400"
                  }`}
                >
                  {active.difficulty}
                </span>
              </div>

              <div
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(active.description) }}
              />

              {active.sampleTestCases.length > 0 && (
                <div className="mt-6 space-y-3">
                  <h3 className="font-semibold text-sm text-gray-300">Sample cases</h3>
                  {active.sampleTestCases.map((tc) => (
                    <div key={tc.ordinal} className="bg-gray-800 p-3 rounded text-xs">
                      <div className="text-gray-400 mb-1">Input</div>
                      <pre className="bg-gray-900 p-2 rounded mb-2 whitespace-pre-wrap">{tc.stdin}</pre>
                      <div className="text-gray-400 mb-1">Expected output</div>
                      <pre className="bg-gray-900 p-2 rounded whitespace-pre-wrap">{tc.expectedOutput}</pre>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-6 text-xs text-gray-600">
                {active.totalTestCount} test cases · {active.timeLimitMs}ms CPU ·{" "}
                {Math.round(active.memoryLimitKb / 1024)}MB
                {active.submissionCount > 0 && ` · ${active.submissionCount} submission(s)`}
              </p>
            </div>

            <ResizeHandle
              axis="x"
              label="Resize the problem panel"
              onMove={dragSplit}
              onNudge={(steps) => setLayout({ splitPct: layout.splitPct + steps * NUDGE_PCT })}
              onReset={() => setLayout({ splitPct: DEFAULT_LAYOUT.splitPct })}
            />

            {/* Editor + results */}
            <div ref={columnRef} className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
                <select
                  value={editor.languageId}
                  onChange={(e) => changeLanguage(active, Number(e.target.value))}
                  className="bg-gray-700 text-sm px-3 py-1.5 rounded border border-gray-600"
                >
                  {active.allowedLanguages.map((id) => (
                    <option key={id} value={id}>
                      {languageName(id)}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-2">
                  <EditorSettingsMenu
                    fontSize={layout.fontSize}
                    onFontSize={(fontSize) => setLayout({ fontSize })}
                    onResetLayout={resetLayout}
                    onOpenRules={() => setRulesOpen(true)}
                  />
                  <button
                    onClick={() => setConfirmReset(true)}
                    disabled={!!activeBusy}
                    title="Restore the starter template for this question"
                    className="px-3 py-1.5 bg-gray-700 rounded text-sm font-medium hover:bg-gray-600 disabled:opacity-50"
                  >
                    Reset code
                  </button>
                  <button
                    onClick={() => execute(active, "run")}
                    disabled={!!activeBusy}
                    className="px-4 py-1.5 bg-gray-700 rounded text-sm font-medium hover:bg-gray-600 disabled:opacity-50"
                  >
                    {activeBusy === "run" ? "Running…" : "Run samples"}
                  </button>
                  <button
                    onClick={() => execute(active, "submit")}
                    disabled={!!activeBusy}
                    className="px-5 py-1.5 bg-green-600 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {activeBusy === "submit" ? "Submitting…" : "Submit"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0">
                <CodeEditor
                  key={active.id}
                  language={getMonacoLanguage(editor.languageId)}
                  value={editor.code}
                  onChange={(code) => updateCode(active.id, code)}
                  proctored
                  onEdit={(change) => handleEdit(active.id, change)}
                  onBlocked={reportEvent}
                  fontSize={layout.fontSize}
                />
              </div>

              <ResultsPanel
                result={result}
                error={resultError}
                busy={!!activeBusy}
                height={layout.resultsPx}
                onMove={dragResults}
                onNudge={(steps) => setLayout({ resultsPx: layout.resultsPx + steps * NUDGE_PX })}
                onReset={() => setLayout({ resultsPx: DEFAULT_LAYOUT.resultsPx })}
              />
            </div>
          </div>
        </div>
      </FullscreenGate>
      </MultiDisplayGate>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[110] bg-red-600 text-white px-5 py-3 rounded-lg shadow-xl text-sm font-medium">
          ⚠️ {toast}
        </div>
      )}

      {/* Reset confirmation */}
      {confirmReset && (
        <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">⚠️ Reset your code?</h2>
            <p className="text-sm text-gray-400 mb-4">
              Everything you have written for{" "}
              <strong className="text-white">{active.title}</strong> in{" "}
              <strong className="text-white">{languageName(editor.languageId)}</strong> is
              discarded and the editor goes back to the starter template. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmReset(false)}
                className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  resetCode(active);
                  setConfirmReset(false);
                }}
                className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700"
              >
                Reset code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Finish confirmation */}
      {confirmFinish && (
        <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center px-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold mb-2">Finish the test?</h2>
            <p className="text-sm text-gray-400 mb-4">
              You have solved <strong className="text-white">{solvedCount}</strong> of{" "}
              <strong className="text-white">{problems.length}</strong> questions. Once you finish
              you cannot return, even if time remains.
            </p>
            {problems.some((p) => !p.attempted) && (
              <p className="text-sm text-yellow-400 bg-yellow-950/40 rounded px-3 py-2 mb-4">
                {problems.filter((p) => !p.attempted).length} question(s) have no submission yet.
              </p>
            )}
            {!online && (
              <p className="text-sm text-yellow-400 bg-yellow-950/40 rounded px-3 py-2 mb-4">
                You are offline, so this cannot be submitted yet. Your work is saved — wait for the
                connection to come back and finish then. Nothing is lost in the meantime, and the
                time this costs you is added back to your clock.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmFinish(false)}
                className="flex-1 px-4 py-2.5 bg-gray-700 rounded font-medium hover:bg-gray-600"
              >
                Keep working
              </button>
              <button
                onClick={() => {
                  flushMetrics();
                  endTest("manual");
                }}
                disabled={ending}
                className="flex-1 px-4 py-2.5 bg-red-600 rounded font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {ending ? "Submitting…" : "Finish test"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rules and instructions, reachable from the editor's gear menu */}
      <RulesDialog
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        instructions={data.instructions}
        violationCount={violations.count}
        maxViolations={violations.max}
      />
    </>
  );
}

interface QuestionSection {
  title: string;
  /** What fits in the 64px rail. */
  short: string;
  /** Index of this section's first question in the flat problem list. */
  offset: number;
  items: SessionProblem[];
}

/**
 * Group the questions into the sections the rail draws. Empty sections are
 * dropped, so a test with three questions or fewer comes back as a single
 * section and the screen renders exactly as it did before sections existed.
 */
function toSections(problems: SessionProblem[]): QuestionSection[] {
  return [
    { title: "Section 1", short: "S1", offset: 0, items: problems.slice(0, SECTION_ONE_COUNT) },
    {
      title: "Section 2",
      short: "S2",
      offset: SECTION_ONE_COUNT,
      items: problems.slice(SECTION_ONE_COUNT),
    },
  ].filter((section) => section.items.length > 0);
}

/** Which section a question index falls in, for the problem panel's header. */
function sectionTitleFor(index: number): string {
  return index < SECTION_ONE_COUNT ? "Section 1" : "Section 2";
}

function emptyBuffer(): MetricBuffer {
  return { keystrokes: 0, charsTyped: 0, activeMs: 0, largestInsertion: 0, bursts: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Candidate-facing copy for a grading poll that couldn't be completed. Nothing
 * here is lost work: `finalizeSession` drains every still-running attempt when
 * the test ends, so an unwatched submission is still scored.
 */
function gradingError(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return "You were signed out while this was grading. Your submission is saved and will still be scored — reload this page to carry on.";
  }
  if (err instanceof HttpError) {
    return `${errorMessage(err, "The judge could not be reached")}. Your submission is saved and will still be scored.`;
  }
  // Reached only after the poll has already waited out POLL_OFFLINE_BUDGET_MS of
  // outage, so this is a long one rather than a blip.
  return "Still offline. Your submission reached the server and will be scored whether or not this screen sees the result — keep working, and it will appear once you reconnect.";
}

/** Fold a window that failed to reach the server back into the live buffer. */
function mergeBuffer(into: MetricBuffer, unsent: MetricBuffer) {
  into.keystrokes += unsent.keystrokes;
  into.charsTyped += unsent.charsTyped;
  into.activeMs += unsent.activeMs;
  into.largestInsertion = Math.max(into.largestInsertion, unsent.largestInsertion);
  // The unsent bursts are the older ones, so they go in front.
  into.bursts = [...unsent.bursts, ...into.bursts];
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
      <div className="max-w-md text-center">{children}</div>
    </div>
  );
}

function ResultsPanel({
  result,
  error,
  busy,
  height,
  onMove,
  onNudge,
  onReset,
}: {
  result: RunResult | null;
  error: string | null;
  busy: boolean;
  height: number;
  onMove: (clientX: number, clientY: number) => void;
  onNudge: (steps: number) => void;
  onReset: () => void;
}) {
  // The handle belongs to the drawer, not to the column: there is nothing to
  // resize on a screen that has not been run yet.
  if (!result && !error && !busy) return null;

  // Defended rather than assumed: anything that reaches this panel without its
  // runs is a bug upstream, and it must not be allowed to throw and unmount the
  // test screen out from under a candidate mid-exam.
  const runs = result?.runs ?? [];
  const passedCount = runs.filter((r) => isAccepted(r.statusId)).length;

  return (
    <>
      <ResizeHandle
        axis="y"
        label="Resize the results panel"
        onMove={onMove}
        onNudge={onNudge}
        onReset={onReset}
      />
      {/* `maxHeight` is what keeps a height dragged tall on a big screen from
          swallowing the editor when the window is later made small. */}
      <div
        style={{ height, maxHeight: "70%" }}
        className="overflow-y-auto bg-gray-800 p-3 shrink-0"
      >
      {error && (
        <p className="text-sm text-yellow-300 bg-yellow-950/40 border border-yellow-900 rounded px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {!result && !error && <p className="text-sm text-gray-400">Sending to the judge…</p>}

      {result && (
        <>
          <div className="flex items-center gap-3 mb-3">
            <h3 className="font-semibold text-sm">
              {result.kind === "run" ? "Sample run" : "Submission"}
            </h3>
            {result.state === "done" ? (
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  result.score === result.maxScore ? "bg-green-600" : "bg-yellow-600"
                }`}
              >
                {/* score and maxScore are weighted point sums, so they cannot be read
                    out as a number of cases: three cases weighted 1/2/1 give a
                    maxScore of 4. The case count comes from the runs themselves. */}
                {passedCount}/{runs.length} tests passed · {result.score}/{result.maxScore} pts
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-600">
                {result.state === "error" ? "Judge error" : "Running…"}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {runs.map((r) => (
              <div
                key={r.ordinal}
                className={`text-xs px-2 py-1.5 rounded flex items-center justify-between ${
                  isAccepted(r.statusId)
                    ? "bg-green-900/30 border border-green-800"
                    : isFailed(r.statusId)
                    ? "bg-red-900/30 border border-red-800"
                    : "bg-gray-700"
                }`}
              >
                <span>
                  Test #{r.ordinal}
                  <span className="text-gray-500 ml-1">({r.kind})</span> —{" "}
                  {isAccepted(r.statusId) ? "✓ " : isFailed(r.statusId) ? "✗ " : ""}
                  {statusLabel(r.statusId)}
                </span>
                {r.timeS != null && (
                  <span className="text-gray-500">
                    {(r.timeS * 1000).toFixed(0)}ms · {r.memoryKb}KB
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Detail is shown for sample cases only — hidden cases stay hidden. */}
          {runs
            .filter((r) => r.kind === "sample" && isFailed(r.statusId))
            .map((r) => (
              <div key={`d-${r.ordinal}`} className="mt-2 bg-gray-900 rounded p-2 text-xs space-y-2">
                {r.compileOutput && (
                  <div>
                    <div className="text-red-400 mb-1">Compile error</div>
                    <pre className="whitespace-pre-wrap text-gray-300">{r.compileOutput}</pre>
                  </div>
                )}
                {r.stderr && (
                  <div>
                    <div className="text-red-400 mb-1">Stderr</div>
                    <pre className="whitespace-pre-wrap text-gray-300">{r.stderr}</pre>
                  </div>
                )}
                {r.statusId === JUDGE0_WRONG_ANSWER && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-yellow-400 mb-1">Your output</div>
                      <pre className="whitespace-pre-wrap text-gray-300">{r.stdout}</pre>
                    </div>
                    <div>
                      <div className="text-green-400 mb-1">Expected</div>
                      <pre className="whitespace-pre-wrap text-gray-300">{r.expectedOutput}</pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </>
      )}
      </div>
    </>
  );
}
