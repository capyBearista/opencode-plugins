import type {
  FinishedReviewRun,
  LatestReview,
  ReviewEventName,
  ReviewOutcome,
  ReviewRun,
  ReviewStatus,
} from "./review-contract.js";

export const DEFAULT_MAX_REVIEW_SESSIONS = 64;

export type ReviewEmitter = (
  event: ReviewEventName,
  snapshot: ReviewStatus,
) => Promise<void> | void;

export interface ReviewLifecycleOptions {
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly onEventError?: (error: unknown) => void;
  readonly maxSessions?: number;
}

export interface ReviewHandle {
  readonly id: string;
  readonly sessionID: string;
  readonly startedAt: number;
}

export interface ReviewLifecycle {
  readonly begin: (sessionID: string) => ReviewHandle;
  readonly finish: (handle: ReviewHandle, outcome: ReviewOutcome, advice?: string) => void;
  readonly status: (sessionID: string) => ReviewStatus;
  readonly forget: (sessionID: string) => void;
  readonly dispose: () => void;
  readonly setEmitter: (emitter: ReviewEmitter | undefined) => void;
}

interface RunningReview {
  readonly run: ReviewRun;
  readonly sequence: number;
}

interface SessionState {
  readonly running: Map<string, RunningReview>;
  lastFinished?: FinishedReviewRun;
  latest?: LatestReview;
  latestSequence?: number;
}

export function createReviewLifecycle(options: ReviewLifecycleOptions = {}): ReviewLifecycle {
  const clock = options.clock ?? Date.now;
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const onEventError = options.onEventError;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_REVIEW_SESSIONS;
  const epoch = crypto.randomUUID();
  const sessions = new Map<string, SessionState>();
  let emitter: ReviewEmitter | undefined;
  let disposed = false;
  let sequence = 0;
  let revision = 0;

  const snapshot = (sessionID: string, state: SessionState): ReviewStatus => ({
    sessionID,
    epoch,
    revision,
    running: [...state.running.values()].map((entry) => ({ ...entry.run })),
    ...(state.lastFinished ? { lastFinished: { ...state.lastFinished } } : {}),
    ...(state.latest ? { latest: { ...state.latest } } : {}),
  });

  const touch = (sessionID: string, state: SessionState): void => {
    sessions.delete(sessionID);
    sessions.set(sessionID, state);
  };

  const ensureSession = (sessionID: string): SessionState | undefined => {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    if (sessions.size >= maxSessions) {
      const idle = [...sessions.entries()].find(([, state]) => state.running.size === 0);
      if (!idle) return undefined;
      sessions.delete(idle[0]);
      revision += 1;
    }
    const created: SessionState = { running: new Map() };
    sessions.set(sessionID, created);
    return created;
  };

  const reportEventError = (error: unknown): void => {
    if (!onEventError) return;
    try {
      onEventError(error);
    } catch {
      return;
    }
  };

  const scheduleEvent = (event: ReviewEventName, status: ReviewStatus): void => {
    queueMicrotask(() => {
      if (disposed) return;
      const current = emitter;
      if (!current) return;
      try {
        void Promise.resolve(current(event, status)).catch(reportEventError);
      } catch (error) {
        reportEventError(error);
      }
    });
  };

  return {
    begin: (sessionID) => {
      const handle: ReviewHandle = { id: idFactory(), sessionID, startedAt: clock() };
      if (disposed) return handle;
      const state = ensureSession(sessionID);
      if (!state) return handle;
      revision += 1;
      sequence += 1;
      state.running.set(handle.id, {
        run: { id: handle.id, startedAt: handle.startedAt },
        sequence,
      });
      touch(sessionID, state);
      scheduleEvent("review.started", snapshot(sessionID, state));
      return handle;
    },
    finish: (handle, outcome, advice) => {
      if (disposed) return;
      const state = sessions.get(handle.sessionID);
      if (!state) return;
      const entry = state.running.get(handle.id);
      if (!entry) return;
      state.running.delete(handle.id);
      revision += 1;
      const finishedAt = clock();
      state.lastFinished = { ...entry.run, finishedAt, outcome };
      if (outcome === "completed" && advice !== undefined) {
        if (state.latestSequence === undefined || entry.sequence > state.latestSequence) {
          state.latest = { id: entry.run.id, finishedAt, advice };
          state.latestSequence = entry.sequence;
        }
      }
      touch(handle.sessionID, state);
      scheduleEvent("review.finished", snapshot(handle.sessionID, state));
    },
    status: (sessionID) => {
      const state = sessions.get(sessionID);
      if (!state) return { sessionID, epoch, revision, running: [] };
      touch(sessionID, state);
      return snapshot(sessionID, state);
    },
    forget: (sessionID) => {
      if (!sessions.delete(sessionID)) return;
      revision += 1;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      emitter = undefined;
      sessions.clear();
    },
    setEmitter: (next) => {
      emitter = next;
    },
  };
}
