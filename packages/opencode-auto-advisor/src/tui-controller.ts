import type { ReviewEventName, ReviewStatus } from "./review-contract.js";

export const REVIEW_SUCCESS_VISIBLE_MS = 2500;
export const REVIEWING_LABEL = "Auto-Advisor reviewing";
export const FINISHED_LABEL = "✓ Auto-Advisor finished";

export interface ReviewViewState {
  readonly running: boolean;
  readonly finished: boolean;
  readonly advice: string | undefined;
}

export const IDLE_REVIEW_STATE: ReviewViewState = {
  running: false,
  finished: false,
  advice: undefined,
};

export interface ReviewTransport {
  readonly query: (
    input: { readonly sessionID: string },
    opts: { readonly signal: AbortSignal },
  ) => Promise<ReviewStatus>;
  readonly subscribe: (name: ReviewEventName, handler: () => void) => () => void;
}

export interface ReviewStoreOptions {
  readonly sessionID: string;
  readonly transport: ReviewTransport;
  readonly onConnected?: (listener: () => void) => () => void;
  readonly successVisibleMs?: number;
  readonly setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (id: unknown) => void;
}

export interface ReviewStore {
  readonly getState: () => ReviewViewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly dispose: () => void;
}

export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const sessionID = options.sessionID;
  const transport = options.transport;
  const visibleMs = options.successVisibleMs ?? REVIEW_SUCCESS_VISIBLE_MS;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let running = false;
  let finished = false;
  let advice: string | undefined;
  let adviceId: string | undefined;
  let pulsedId: string | undefined;
  let pulseTimer: unknown;
  let queryAbort: AbortController | undefined;
  let offConnected: (() => void) | undefined;
  let unsubs: Array<() => void> = [];
  let querySeq = 0;
  let disposed = false;
  let started = false;
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
    if (pulseTimer === undefined) return;
    try {
      clearTimeoutFn(pulseTimer);
    } catch {
      undefined;
    }
    pulseTimer = undefined;
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

  const apply = (status: ReviewStatus): void => {
    if (disposed) return;
    if (status.sessionID !== sessionID) return;
    running = status.running.length > 0;
    const latest = status.latest;
    if (latest === undefined) {
      advice = undefined;
      adviceId = undefined;
    } else if (latest.advice.trim().length > 0 && latest.id !== adviceId) {
      advice = latest.advice;
      adviceId = latest.id;
    }
    const usableLatest = latest !== undefined && latest.advice.trim().length > 0;
    const last = status.lastFinished;
    if (running) {
      finished = false;
      clearPulse();
    } else if (last?.outcome === "completed" && usableLatest) {
      if (last.id !== pulsedId) {
        pulsedId = last.id;
        finished = true;
        restartPulse();
      }
    } else {
      finished = false;
      clearPulse();
    }
    notify();
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

  const sync = (): void => {
    if (disposed || !started) return;
    querySeq += 1;
    const seq = querySeq;
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
      return;
    }
    void Promise.resolve(result).then(
      (status) => {
        if (seq === querySeq) apply(status);
      },
      () => undefined,
    );
  };

  const subscribeEvents = (): void => {
    for (const name of ["review.started", "review.finished"] as const) {
      try {
        unsubs.push(transport.subscribe(name, sync));
      } catch {
        unsubs.push(() => undefined);
      }
    }
  };

  const reconnect = (): void => {
    if (disposed || !started) return;
    unsubscribeAll();
    subscribeEvents();
    sync();
  };

  return {
    getState: () => ({ running, finished, advice }),
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
      subscribeEvents();
      if (options.onConnected) {
        try {
          offConnected = options.onConnected(reconnect);
        } catch {
          offConnected = undefined;
        }
      }
      sync();
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
      try {
        offConnected?.();
      } catch {
        undefined;
      }
      offConnected = undefined;
      unsubscribeAll();
      clearPulse();
      listeners.clear();
    },
  };
}

export interface ReviewStoreKey {
  readonly sessionID: string;
  readonly directory: string;
}

export interface ReviewStoreHandle {
  readonly store: ReviewStore;
  readonly release: () => void;
}

export interface ReviewStoreRegistry {
  readonly acquire: (key: ReviewStoreKey) => ReviewStoreHandle | undefined;
  readonly dispose: () => void;
}

export function createReviewStoreRegistry(
  create: (key: ReviewStoreKey) => ReviewStore | undefined,
): ReviewStoreRegistry {
  interface Entry {
    readonly store: ReviewStore;
    refs: number;
  }
  const entries = new Map<string, Entry>();
  let disposed = false;

  const handleFor = (id: string, entry: Entry): ReviewStoreHandle => {
    let released = false;
    return {
      store: entry.store,
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs > 0) return;
        if (entries.get(id) === entry) entries.delete(id);
        if (disposed) return;
        entry.store.dispose();
      },
    };
  };

  return {
    acquire: (key) => {
      if (disposed) return undefined;
      const id = `${key.directory}\u0000${key.sessionID}`;
      const existing = entries.get(id);
      if (existing) {
        existing.refs += 1;
        return handleFor(id, existing);
      }
      let store: ReviewStore | undefined;
      try {
        store = create(key);
      } catch {
        store = undefined;
      }
      if (store === undefined) return undefined;
      const entry: Entry = { store, refs: 1 };
      entries.set(id, entry);
      try {
        store.start();
      } catch {
        entries.delete(id);
        store.dispose();
        return undefined;
      }
      return handleFor(id, entry);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) entry.store.dispose();
      entries.clear();
    },
  };
}

export function isLocalReviewEnvelope(
  envelope: {
    readonly location: { readonly directory: string };
    readonly data: { readonly sessionID: string };
  },
  sessionID: string,
  directory: string,
): boolean {
  return envelope.data.sessionID === sessionID && envelope.location.directory === directory;
}
