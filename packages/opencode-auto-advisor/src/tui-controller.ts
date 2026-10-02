import type { ReviewEventName, ReviewStatus } from "./review-contract.js";

export const REVIEW_SUCCESS_VISIBLE_MS = 2500;
export const REVIEWING_LABEL = "Auto-Advisor reviewing";
export const FINISHED_LABEL = "✓ Auto-Advisor finished";

export interface ReviewViewState {
  readonly reviewing: boolean;
  readonly finished: boolean;
  readonly advice: string | undefined;
  readonly adviceId: string | undefined;
}

export interface ReviewTransport {
  readonly query: (
    input: { readonly sessionID: string },
    opts: { readonly signal: AbortSignal },
  ) => Promise<ReviewStatus>;
  readonly subscribe: (
    name: ReviewEventName,
    handler: (snapshot: ReviewStatus) => void,
  ) => () => void;
}

export interface ReviewControllerOptions {
  readonly sessionID: string;
  readonly transport: ReviewTransport;
  readonly successVisibleMs?: number;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (id: unknown) => void;
}

export interface ReviewController {
  readonly getState: () => ReviewViewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly refresh: () => void;
  readonly reconnect: () => void;
  readonly dispose: () => void;
}

interface ReviewEnvelope {
  readonly location: { readonly directory: string };
  readonly data: { readonly sessionID: string };
}

export function isLocalReviewEnvelope(
  envelope: ReviewEnvelope,
  sessionID: string,
  directory: string,
): boolean {
  return envelope.data.sessionID === sessionID && envelope.location.directory === directory;
}

export function createReviewController(options: ReviewControllerOptions): ReviewController {
  const sessionID = options.sessionID;
  const transport = options.transport;
  const visibleMs = options.successVisibleMs ?? REVIEW_SUCCESS_VISIBLE_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let establishedEpoch: string | undefined;
  let establishedOwnership = 0;
  let revision = -1;
  let reviewing = false;
  let finished = false;
  let advice: string | undefined;
  let adviceId: string | undefined;
  let pulseId: string | undefined;
  let confirmEpoch: string | undefined;
  let confirmOwnership = 0;
  let hintEpoch: string | undefined;
  let hintRevision = -1;
  let disposed = false;
  let started = false;
  let transportGen = 0;
  let ownershipSeq = 0;
  let activeOwnership = 0;
  let queryAbort: AbortController | undefined;
  let pulseTimer: unknown;
  let unsubs: Array<() => void> = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        return;
      }
    }
  };

  const clearPulse = (): void => {
    if (pulseTimer !== undefined) {
      try {
        clearTimeoutFn(pulseTimer);
      } catch {
        undefined;
      }
      pulseTimer = undefined;
    }
  };

  const restartPulse = (): void => {
    clearPulse();
    try {
      pulseTimer = setTimeoutFn(() => {
        pulseTimer = undefined;
        if (disposed) return;
        finished = false;
        notify();
      }, visibleMs);
    } catch {
      pulseTimer = undefined;
    }
  };

  const reconcileLatest = (snapshot: ReviewStatus): void => {
    const latest = snapshot.latest;
    if (!latest) return;
    if (typeof latest.advice !== "string" || latest.advice.trim().length === 0) return;
    if (adviceId === latest.id) return;
    advice = latest.advice;
    adviceId = latest.id;
  };

  const hasUsableLatest = (snapshot: ReviewStatus): boolean => {
    const latest = snapshot.latest;
    return !!latest && typeof latest.advice === "string" && latest.advice.trim().length > 0;
  };

  const showIndicators = (snapshot: ReviewStatus): void => {
    if (snapshot.running.length > 0) {
      reviewing = true;
      finished = false;
      clearPulse();
      return;
    }
    reviewing = false;
    const last = snapshot.lastFinished;
    if (last?.outcome === "completed" && hasUsableLatest(snapshot)) {
      if (last.id !== pulseId) {
        pulseId = last.id;
        finished = true;
        restartPulse();
      }
      return;
    }
    finished = false;
    clearPulse();
  };

  const nextOwnership = (): number => {
    ownershipSeq += 1;
    return ownershipSeq;
  };

  const applyEvent = (snapshot: ReviewStatus, gen: number): void => {
    if (disposed) return;
    if (gen !== transportGen) return;
    if (snapshot.sessionID !== sessionID) return;
    if (establishedEpoch === undefined) {
      establishedEpoch = snapshot.epoch;
      establishedOwnership = activeOwnership;
      revision = snapshot.revision;
      reconcileLatest(snapshot);
      showIndicators(snapshot);
      notify();
      return;
    }
    if (snapshot.epoch !== establishedEpoch) {
      if (confirmEpoch !== snapshot.epoch) {
        issueQuery(snapshot.epoch);
        hintEpoch = snapshot.epoch;
        hintRevision = snapshot.revision;
      } else if (hintEpoch !== snapshot.epoch || snapshot.revision > hintRevision) {
        hintEpoch = snapshot.epoch;
        hintRevision = snapshot.revision;
      }
      return;
    }
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    reconcileLatest(snapshot);
    showIndicators(snapshot);
    notify();
  };

  const applyQuery = (snapshot: ReviewStatus, gen: number, ownership: number): void => {
    if (disposed) return;
    if (gen !== transportGen) return;
    if (ownership !== activeOwnership) return;
    if (snapshot.sessionID !== sessionID) return;
    if (establishedEpoch === undefined) {
      establishedEpoch = snapshot.epoch;
      establishedOwnership = ownership;
      revision = snapshot.revision;
      reconcileLatest(snapshot);
      showIndicators(snapshot);
      notify();
      return;
    }
    if (snapshot.epoch !== establishedEpoch) {
      if (ownership <= establishedOwnership) return;
      establishedEpoch = snapshot.epoch;
      establishedOwnership = ownership;
      revision = snapshot.revision;
      advice = undefined;
      adviceId = undefined;
      pulseId = undefined;
      reconcileLatest(snapshot);
      showIndicators(snapshot);
      notify();
      return;
    }
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    reconcileLatest(snapshot);
    showIndicators(snapshot);
    notify();
  };

  const subscribeBoth = (gen: number): void => {
    for (const name of ["review.started", "review.finished"] as const) {
      try {
        unsubs.push(transport.subscribe(name, (snapshot) => applyEvent(snapshot, gen)));
      } catch {
        unsubs.push(() => undefined);
      }
    }
  };

  const unsubscribeAll = (): void => {
    const pending = unsubs;
    unsubs = [];
    for (const unsubscribe of pending) {
      try {
        unsubscribe();
      } catch {
        undefined;
      }
    }
  };

  const issueQuery = (confirmation?: string): void => {
    const gen = transportGen;
    activeOwnership = nextOwnership();
    const ownership = activeOwnership;
    if (confirmation !== undefined) {
      confirmEpoch = confirmation;
      confirmOwnership = ownership;
    } else {
      confirmEpoch = undefined;
      hintEpoch = undefined;
      hintRevision = -1;
    }
    try {
      queryAbort?.abort();
    } catch {
      undefined;
    }
    const controller = new AbortController();
    queryAbort = controller;
    let result: Promise<ReviewStatus>;
    try {
      result = transport.query({ sessionID }, { signal: controller.signal });
    } catch {
      if (ownership === confirmOwnership) {
        confirmEpoch = undefined;
        hintEpoch = undefined;
        hintRevision = -1;
      }
      return;
    }
    void Promise.resolve(result).then(
      (snapshot) => {
        const wasConfirming = ownership === confirmOwnership;
        const savedHintEpoch = hintEpoch;
        const savedHintRevision = hintRevision;
        if (wasConfirming) {
          confirmEpoch = undefined;
          hintEpoch = undefined;
          hintRevision = -1;
        }
        try {
          applyQuery(snapshot, gen, ownership);
        } catch {
          return;
        }
        if (!wasConfirming) return;
        if (disposed) return;
        if (gen !== transportGen) return;
        if (snapshot.sessionID !== sessionID) return;
        if (savedHintEpoch === undefined) return;
        if (savedHintEpoch !== snapshot.epoch) return;
        if (savedHintRevision <= snapshot.revision) return;
        issueQuery(savedHintEpoch);
      },
      () => {
        if (ownership === confirmOwnership) {
          confirmEpoch = undefined;
          hintEpoch = undefined;
          hintRevision = -1;
        }
      },
    );
  };

  return {
    getState: () => ({ reviewing, finished, advice, adviceId }),
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (disposed || started) return;
      started = true;
      subscribeBoth(transportGen);
      issueQuery();
    },
    refresh: () => {
      if (disposed || !started) return;
      issueQuery();
    },
    reconnect: () => {
      if (disposed || !started) return;
      transportGen += 1;
      const gen = transportGen;
      unsubscribeAll();
      subscribeBoth(gen);
      issueQuery();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        queryAbort?.abort();
      } catch {
        undefined;
      }
      queryAbort = undefined;
      unsubscribeAll();
      clearPulse();
      listeners.clear();
    },
  };
}
