import { describe, expect, test } from "bun:test";
import type { ReviewEventName, ReviewStatus } from "./review-contract.js";
import {
  createReviewStore,
  createReviewStoreRegistry,
  IDLE_REVIEW_STATE,
  isLocalReviewEnvelope,
  REVIEW_SUCCESS_VISIBLE_MS,
  type ReviewStore,
  type ReviewStoreKey,
  type ReviewTransport,
} from "./tui-controller.js";

type TimerCallback = () => void;

interface FakeTimers {
  readonly setTimeoutFn: (callback: TimerCallback, ms: number) => number;
  readonly clearTimeoutFn: (id: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
}

function createFakeTimers(): FakeTimers {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; callback: TimerCallback }>();
  return {
    setTimeoutFn: (callback, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, callback });
      return next;
    },
    clearTimeoutFn: (id) => {
      timers.delete(id as number);
    },
    advance: (ms) => {
      now += ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort(([, left], [, right]) => left.at - right.at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    pending: () => timers.size,
  };
}

interface PendingQuery {
  readonly sessionID: string;
  readonly signal: AbortSignal;
  readonly resolve: (status: ReviewStatus) => void;
  readonly reject: (reason?: unknown) => void;
}

interface FakeTransport extends ReviewTransport {
  readonly queries: PendingQuery[];
  readonly handlers: Map<string, Array<() => void>>;
  readonly unsubscribes: string[];
  readonly order: string[];
  emit: (name: ReviewEventName) => void;
}

function createFakeTransport(): FakeTransport {
  const queries: PendingQuery[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const transport: FakeTransport = {
    queries,
    handlers,
    unsubscribes: [],
    order: [],
    query: (input, opts) => {
      transport.order.push("query");
      let resolve!: (status: ReviewStatus) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<ReviewStatus>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
      });
      queries.push({ sessionID: input.sessionID, signal: opts.signal, resolve, reject });
      return promise;
    },
    subscribe: (name, handler) => {
      transport.order.push(`subscribe:${name}`);
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        transport.unsubscribes.push(name);
      };
    },
    emit: (name) => {
      for (const handler of transport.handlers.get(name) ?? []) handler();
    },
  };
  return transport;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function status(
  sessionID: string,
  overrides: Partial<Omit<ReviewStatus, "sessionID">> = {},
): ReviewStatus {
  return { sessionID, epoch: "epoch-a", revision: 1, running: [], ...overrides };
}

const RUNNING = {
  running: [{ id: "run_1", startedAt: 1 }],
} as const;

const COMPLETED = {
  running: [],
  lastFinished: { id: "run_1", startedAt: 1, finishedAt: 2, outcome: "completed" as const },
  latest: { id: "run_1", finishedAt: 2, advice: "first advice" },
} as const;

describe("review store", () => {
  test("subscribes before querying and applies the authoritative query result", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    store.start();
    expect(transport.order).toEqual([
      "subscribe:review.started",
      "subscribe:review.finished",
      "query",
    ]);
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
    transport.queries[0]?.resolve(status("ses_1", RUNNING));
    await flush();
    expect(store.getState()).toEqual({ running: true, finished: false, advice: undefined });
  });

  test("events only invalidate: a fresh authoritative query decides the state", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", RUNNING));
    await flush();
    transport.emit("review.finished");
    expect(transport.queries).toHaveLength(2);
    expect(transport.queries[0]?.signal.aborted).toBe(true);
    transport.queries[1]?.resolve(status("ses_1", COMPLETED));
    await flush();
    expect(store.getState()).toEqual({ running: false, finished: true, advice: "first advice" });
  });

  test("pulses finished for the visible window and keeps the advice", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const store = createReviewStore({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", COMPLETED));
    await flush();
    expect(store.getState().finished).toBe(true);
    timers.advance(REVIEW_SUCCESS_VISIBLE_MS - 1);
    expect(store.getState().finished).toBe(true);
    timers.advance(1);
    expect(store.getState()).toEqual({ running: false, finished: false, advice: "first advice" });
  });

  test("duplicate completion delivery keeps the original pulse deadline", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const store = createReviewStore({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", COMPLETED));
    await flush();
    timers.advance(1000);
    transport.emit("review.finished");
    transport.queries[1]?.resolve(status("ses_1", COMPLETED));
    await flush();
    expect(timers.pending()).toBe(1);
    timers.advance(REVIEW_SUCCESS_VISIBLE_MS - 1000 - 1);
    expect(store.getState().finished).toBe(true);
    timers.advance(1);
    expect(store.getState().finished).toBe(false);
  });

  test("drops a stale query response that resolves after a newer query", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    store.start();
    transport.emit("review.started");
    expect(transport.queries).toHaveLength(2);
    transport.queries[1]?.resolve(status("ses_1", RUNNING));
    await flush();
    transport.queries[0]?.resolve(status("ses_1"));
    await flush();
    expect(store.getState().running).toBe(true);
  });

  test("a failure outcome clears the running indicator without wiping previous advice", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", RUNNING));
    await flush();
    transport.emit("review.finished");
    transport.queries[1]?.resolve(
      status("ses_1", {
        running: [],
        lastFinished: { id: "run_1", startedAt: 1, finishedAt: 2, outcome: "failed" },
        latest: { id: "run_0", finishedAt: 0, advice: "older advice" },
      }),
    );
    await flush();
    expect(store.getState()).toEqual({ running: false, finished: false, advice: "older advice" });
  });

  test("an authoritative status without latest clears the advice", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", COMPLETED));
    await flush();
    expect(store.getState().advice).toBe("first advice");
    transport.emit("review.started");
    transport.queries[1]?.resolve(status("ses_1"));
    await flush();
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
  });

  test("reconnect renews both subscriptions before querying again", async () => {
    const transport = createFakeTransport();
    let connected: (() => void) | undefined;
    const store = createReviewStore({
      sessionID: "ses_1",
      transport,
      onConnected: (listener) => {
        connected = listener;
        return () => undefined;
      },
    });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", RUNNING));
    await flush();
    transport.order.length = 0;
    connected?.();
    expect(transport.order).toEqual([
      "subscribe:review.started",
      "subscribe:review.finished",
      "query",
    ]);
    expect(transport.unsubscribes).toEqual(["review.started", "review.finished"]);
    transport.queries[1]?.resolve(status("ses_1"));
    await flush();
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
  });

  test("stays quiet on rejected queries, ignores foreign sessions, and disposes cleanly", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.start();
    transport.queries[0]?.reject(new Error("rpc.unavailable"));
    await flush();
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
    transport.emit("review.started");
    transport.queries[1]?.resolve(status("ses_other", RUNNING));
    await flush();
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
    expect(notifications).toBe(0);
    transport.emit("review.started");
    const active = transport.queries[2];
    store.dispose();
    expect(active?.signal.aborted).toBe(true);
    active?.resolve(status("ses_1", RUNNING));
    await flush();
    expect(store.getState()).toEqual(IDLE_REVIEW_STATE);
    expect(notifications).toBe(0);
    unsubscribe();
    expect(transport.unsubscribes).toEqual(["review.started", "review.finished"]);
    store.start();
    expect(transport.queries).toHaveLength(3);
  });

  test("a throwing listener does not stop notification of remaining listeners", async () => {
    const transport = createFakeTransport();
    const store = createReviewStore({ sessionID: "ses_1", transport });
    let later = 0;
    store.subscribe(() => {
      throw new Error("listener exploded");
    });
    store.subscribe(() => {
      later += 1;
    });
    store.start();
    transport.queries[0]?.resolve(status("ses_1", COMPLETED));
    await flush();
    expect(later).toBe(1);
    store.dispose();
  });
});

describe("review store registry", () => {
  function harness() {
    let created = 0;
    let disposed = 0;
    const keys: ReviewStoreKey[] = [];
    const transports: FakeTransport[] = [];
    const registry = createReviewStoreRegistry((key) => {
      created += 1;
      keys.push(key);
      const transport = createFakeTransport();
      transports.push(transport);
      const store = createReviewStore({ sessionID: key.sessionID, transport });
      return {
        ...store,
        dispose: () => {
          disposed += 1;
          store.dispose();
        },
      } satisfies ReviewStore;
    });
    return {
      registry,
      keys,
      transports,
      created: () => created,
      disposed: () => disposed,
    };
  }

  test("shares one store per session and directory until the last release", async () => {
    const fake = harness();
    const key = { sessionID: "ses_1", directory: "/work/main" };
    const first = fake.registry.acquire(key);
    const second = fake.registry.acquire(key);
    expect(first).toBeDefined();
    expect(second?.store).toBe(first?.store);
    expect(fake.created()).toBe(1);
    expect(fake.transports[0]?.queries).toHaveLength(1);
    first?.release();
    first?.release();
    expect(fake.disposed()).toBe(0);
    second?.release();
    expect(fake.disposed()).toBe(1);
    const third = fake.registry.acquire(key);
    expect(third?.store).not.toBe(first?.store);
    expect(fake.created()).toBe(2);
    third?.release();
  });

  test("separates sessions and directories", () => {
    const fake = harness();
    const one = fake.registry.acquire({ sessionID: "ses_1", directory: "/work/main" });
    const two = fake.registry.acquire({ sessionID: "ses_2", directory: "/work/main" });
    const three = fake.registry.acquire({ sessionID: "ses_1", directory: "/work/other" });
    expect(fake.created()).toBe(3);
    expect(one?.store).not.toBe(two?.store);
    expect(one?.store).not.toBe(three?.store);
    one?.release();
    two?.release();
    three?.release();
  });

  test("disposes live stores and refuses new acquisitions", () => {
    const fake = harness();
    const handle = fake.registry.acquire({ sessionID: "ses_1", directory: "/work/main" });
    fake.registry.dispose();
    expect(fake.disposed()).toBe(1);
    expect(fake.registry.acquire({ sessionID: "ses_1", directory: "/work/main" })).toBeUndefined();
    handle?.release();
    expect(fake.disposed()).toBe(1);
  });

  test("stays quiet when store creation fails", () => {
    const registry = createReviewStoreRegistry(() => undefined);
    expect(registry.acquire({ sessionID: "ses_1", directory: "/work/main" })).toBeUndefined();
  });
});

describe("review envelope isolation", () => {
  test("matches only the bound session and directory", () => {
    const envelope = {
      location: { directory: "/work/main" },
      data: { sessionID: "ses_1" },
    };
    expect(isLocalReviewEnvelope(envelope, "ses_1", "/work/main")).toBe(true);
    expect(isLocalReviewEnvelope(envelope, "ses_2", "/work/main")).toBe(false);
    expect(isLocalReviewEnvelope(envelope, "ses_1", "/work/other")).toBe(false);
  });
});
