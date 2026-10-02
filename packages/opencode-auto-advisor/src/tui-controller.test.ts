import { describe, expect, test } from "bun:test";
import type { ReviewStatus } from "./review-contract.js";
import {
  createReviewController,
  FINISHED_LABEL,
  isLocalReviewEnvelope,
  REVIEW_SUCCESS_VISIBLE_MS,
  REVIEWING_LABEL,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

interface FakeTransport extends ReviewTransport {
  readonly queries: Array<{ sessionID: string; signal: AbortSignal }>;
  readonly handlers: Map<string, Array<(snapshot: ReviewStatus) => void>>;
  readonly unsubscribes: Array<string>;
  nextQuery: ReturnType<typeof createDeferred<ReviewStatus>> | undefined;
  queryCalls: number;
  subscribeCalls: number;
  order: Array<string>;
}

function createFakeTransport(): FakeTransport {
  const queries: FakeTransport["queries"] = [];
  const handlers = new Map<string, Array<(snapshot: ReviewStatus) => void>>();
  const transport: FakeTransport = {
    queries,
    handlers,
    unsubscribes: [],
    nextQuery: undefined,
    queryCalls: 0,
    subscribeCalls: 0,
    order: [],
    query: (input, opts) => {
      transport.queryCalls += 1;
      transport.order.push("query");
      queries.push({ sessionID: input.sessionID, signal: opts.signal });
      const deferred = createDeferred<ReviewStatus>();
      transport.nextQuery = deferred;
      return deferred.promise;
    },
    subscribe: (name, handler) => {
      transport.subscribeCalls += 1;
      transport.order.push(`subscribe:${name}`);
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        transport.unsubscribes.push(name);
      };
    },
  };
  return transport;
}

function emit(transport: FakeTransport, name: string, snapshot: ReviewStatus): void {
  for (const handler of transport.handlers.get(name) ?? []) handler(snapshot);
}

function runningStatus(overrides: Partial<ReviewStatus> & { sessionID: string }): ReviewStatus {
  return {
    epoch: "epoch-a",
    revision: 1,
    running: [],
    ...overrides,
  };
}

describe("tui-controller reviewing indicator", () => {
  test("stays quiet for idle states and shows reviewing while a run is held", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(transport, "review.finished", runningStatus({ sessionID: "ses_1", revision: 1 }));
    expect(controller.getState().reviewing).toBe(false);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        revision: 2,
        running: [{ id: "run-1", startedAt: 10 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    controller.dispose();
  });

  test("pulses finished on success for about 2500ms while keeping advice", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    expect(REVIEWING_LABEL).toBe("Auto-Advisor reviewing");
    expect(FINISHED_LABEL).toBe("✓ Auto-Advisor finished");
    expect(REVIEW_SUCCESS_VISIBLE_MS).toBe(2500);
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 2,
        lastFinished: { id: "run-1", startedAt: 10, finishedAt: 20, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 20, advice: "Ship it with a test." },
      }),
    );
    expect(controller.getState()).toMatchObject({
      reviewing: false,
      finished: true,
      advice: "Ship it with a test.",
    });
    expect(timers.pending()).toBe(1);
    timers.advance(2499);
    expect(controller.getState().finished).toBe(true);
    timers.advance(1);
    expect(controller.getState().finished).toBe(false);
    expect(controller.getState().advice).toBe("Ship it with a test.");
    controller.dispose();
  });

  test("clears running quietly on failure or timeout without wiping previous advice", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Kept advice." },
      }),
    );
    timers.advance(2500);
    let revision = 2;
    for (const outcome of ["failed", "timeout"] as const) {
      emit(
        transport,
        "review.started",
        runningStatus({
          sessionID: "ses_1",
          revision,
          running: [{ id: "run-2", startedAt: 3 }],
        }),
      );
      revision += 1;
      expect(controller.getState().reviewing).toBe(true);
      emit(
        transport,
        "review.finished",
        runningStatus({
          sessionID: "ses_1",
          revision,
          lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome },
        }),
      );
      revision += 1;
      expect(controller.getState()).toMatchObject({
        reviewing: false,
        finished: false,
        advice: "Kept advice.",
      });
    }
    expect(timers.pending()).toBe(0);
    controller.dispose();
  });

  test("replaces advice only on newer successful reviews", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "First." },
      }),
    );
    timers.advance(2500);
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Second." },
      }),
    );
    expect(controller.getState().advice).toBe("Second.");
    controller.dispose();
  });
});

describe("tui-controller reconstruction and races", () => {
  test("subscribes before querying and reconstructs running status from the query", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    expect(transport.order.slice(0, 2)).toEqual([
      "subscribe:review.started",
      "subscribe:review.finished",
    ]);
    expect(transport.order[2]).toBe("query");
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 7,
        running: [{ id: "run-9", startedAt: 5 }],
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState().reviewing).toBe(true);
    controller.dispose();
  });

  test("reconstructs finished advice from the query", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 3,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Reconstructed." },
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Reconstructed.");
    expect(controller.getState().finished).toBe(true);
    controller.dispose();
  });

  test("rejects a stale query that resolves after a newer event", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    const pending = transport.nextQuery;
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 5,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Newer." },
      }),
    );
    pending?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 2,
        running: [{ id: "run-1", startedAt: 1 }],
      }),
    );
    await pending?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Newer." });
    controller.dispose();
  });

  test("epoch changes apply from authoritative queries while unconfirmed events stay inert", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    expect(controller.getState().advice).toBe("Advice A.");
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    expect(controller.getState().advice).toBe("Advice A.");
    controller.refresh();
    const recovery = transport.nextQuery;
    recovery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    await recovery?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Advice B.");
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 2,
        lastFinished: { id: "run-3", startedAt: 5, finishedAt: 6, outcome: "completed" },
        latest: { id: "run-3", finishedAt: 6, advice: "Advice A2." },
      }),
    );
    expect(controller.getState().advice).toBe("Advice B.");
    controller.dispose();
  });

  test("isolates other sessions and stays reviewing with concurrent run ids", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_other",
        revision: 50,
        running: [{ id: "run-x", startedAt: 1 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(false);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        revision: 1,
        running: [
          { id: "run-1", startedAt: 1 },
          { id: "run-2", startedAt: 2 },
        ],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 2,
        running: [{ id: "run-2", startedAt: 2 }],
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 3, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 3, advice: "Partial." },
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    controller.dispose();
  });

  test("filters event envelopes by both location directory and session id", () => {
    expect(
      isLocalReviewEnvelope(
        { location: { directory: "/work/a" }, data: { sessionID: "ses_1" } },
        "ses_1",
        "/work/a",
      ),
    ).toBe(true);
    expect(
      isLocalReviewEnvelope(
        { location: { directory: "/work/b" }, data: { sessionID: "ses_1" } },
        "ses_1",
        "/work/a",
      ),
    ).toBe(false);
    expect(
      isLocalReviewEnvelope(
        { location: { directory: "/work/a" }, data: { sessionID: "ses_2" } },
        "ses_1",
        "/work/a",
      ),
    ).toBe(false);
  });
});

describe("tui-controller disposal and quiet unsupported handling", () => {
  test("pending queries and late events stay inert after dispose and cleanup is idempotent", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    let notifications = 0;
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.subscribe(() => {
      notifications += 1;
    });
    controller.start();
    const pending = transport.nextQuery;
    controller.dispose();
    controller.dispose();
    pending?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 10,
        running: [{ id: "run-late", startedAt: 1 }],
      }),
    );
    await pending?.promise.catch(() => undefined);
    await Promise.resolve();
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        revision: 11,
        running: [{ id: "run-late", startedAt: 1 }],
      }),
    );
    timers.advance(10000);
    expect(controller.getState()).toEqual({
      reviewing: false,
      finished: false,
      advice: undefined,
      adviceId: undefined,
    });
    expect(transport.unsubscribes).toHaveLength(2);
    expect(timers.pending()).toBe(0);
    expect(notifications).toBe(0);
  });

  test("a rejected status query stays quiet instead of throwing", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    transport.nextQuery?.reject(new Error("rpc.method_not_found"));
    await transport.nextQuery?.promise.catch(() => undefined);
    await Promise.resolve();
    expect(controller.getState()).toEqual({
      reviewing: false,
      finished: false,
      advice: undefined,
      adviceId: undefined,
    });
    controller.dispose();
  });

  test("refresh issues a new owned query and ignores the superseded one", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    const first = transport.nextQuery;
    controller.refresh();
    const second = transport.nextQuery;
    expect(transport.queryCalls).toBe(2);
    first?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 20,
        running: [{ id: "run-old", startedAt: 1 }],
      }),
    );
    await first?.promise;
    await Promise.resolve();
    expect(controller.getState().reviewing).toBe(false);
    second?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 21,
        running: [{ id: "run-new", startedAt: 2 }],
      }),
    );
    await second?.promise;
    await Promise.resolve();
    expect(controller.getState().reviewing).toBe(true);
    controller.dispose();
  });
});

describe("tui-controller gate regressions", () => {
  test("F1 terminated streams renew both live subscriptions before the recovery query", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        running: [{ id: "run-1", startedAt: 1 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    const staleStarted = [...(transport.handlers.get("review.started") ?? [])];
    const staleFinished = [...(transport.handlers.get("review.finished") ?? [])];
    const staleQuery = transport.nextQuery;
    transport.handlers.clear();
    const orderBefore = transport.order.length;
    controller.reconnect();
    expect(transport.order.slice(orderBefore, orderBefore + 2)).toEqual([
      "subscribe:review.started",
      "subscribe:review.finished",
    ]);
    expect(transport.order[orderBefore + 2]).toBe("query");
    expect(transport.unsubscribes).toHaveLength(2);
    staleQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        running: [{ id: "run-1", startedAt: 1 }],
      }),
    );
    await staleQuery?.promise;
    await Promise.resolve();
    const recovery = transport.nextQuery;
    recovery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 2,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Recovered." },
      }),
    );
    await recovery?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Recovered.");
    for (const stale of [...staleStarted, ...staleFinished]) {
      stale(
        runningStatus({
          sessionID: "ses_1",
          epoch: "epoch-a",
          revision: 99,
          running: [{ id: "run-stale", startedAt: 9 }],
        }),
      );
    }
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Recovered." });
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 3,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    controller.dispose();
  });

  test("F2a newer success event beats a delayed still-owned running query", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    const owned = transport.nextQuery;
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 5,
        lastFinished: { id: "run-b", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-b", finishedAt: 4, advice: "Newer advice." },
      }),
    );
    expect(controller.getState().advice).toBe("Newer advice.");
    owned?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 2,
        running: [{ id: "run-a", startedAt: 1 }],
      }),
    );
    await owned?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Newer advice." });
    controller.dispose();
  });

  test("F2b newer success query beats a late older-epoch event with a higher revision", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    controller.refresh();
    const current = transport.nextQuery;
    current?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 5,
        lastFinished: { id: "run-b", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-b", finishedAt: 4, advice: "Current advice." },
      }),
    );
    await current?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Current advice.");
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 99,
        lastFinished: { id: "run-a", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-a", finishedAt: 2, advice: "Stale advice." },
      }),
    );
    expect(controller.getState().advice).toBe("Current advice.");
    controller.dispose();
  });

  test("F4a mount query with a failure outcome but valid latest restores advice quietly", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        revision: 4,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "failed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Kept through failure." },
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({
      reviewing: false,
      finished: false,
      advice: "Kept through failure.",
    });
    expect(timers.pending()).toBe(0);
    controller.dispose();
  });

  test("F4b newer latest during concurrent running survives a later failure", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "First advice." },
      }),
    );
    timers.advance(2500);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        revision: 2,
        running: [{ id: "run-3", startedAt: 5 }],
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Second advice." },
      }),
    );
    expect(controller.getState()).toMatchObject({ reviewing: true, advice: "Second advice." });
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        revision: 3,
        lastFinished: { id: "run-3", startedAt: 5, finishedAt: 6, outcome: "failed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Second advice." },
      }),
    );
    expect(controller.getState()).toMatchObject({
      reviewing: false,
      finished: false,
      advice: "Second advice.",
    });
    controller.dispose();
  });
});

describe("tui-controller confirmation, authority, and pulse identity", () => {
  test("G1 foreign same-stream event auto-confirms with one bounded query and no UI mutation", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    timers.advance(2500);
    const callsBefore = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    expect(transport.queryCalls).toBe(callsBefore + 1);
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 3,
        running: [{ id: "run-3", startedAt: 5 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Advice B.");
    expect(transport.queryCalls).toBe(callsBefore + 2);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-c",
        revision: 1,
        running: [{ id: "run-5", startedAt: 8 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 3);
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice B." });
    controller.dispose();
  });

  test("G1c coalesced finished hint converges without another hint", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    timers.advance(2500);
    const callsBefore = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    expect(transport.queryCalls).toBe(callsBefore + 1);
    const pending = transport.nextQuery;
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    pending?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    await pending?.promise;
    await Promise.resolve();
    expect(transport.queryCalls).toBe(callsBefore + 2);
    const catchup = transport.nextQuery;
    expect(catchup).not.toBe(pending);
    catchup?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    await catchup?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice B." });
    await Promise.resolve();
    expect(transport.queryCalls).toBe(callsBefore + 2);
    controller.dispose();
  });

  test("G1d already-ahead query needs no catchup and lower hints stay inert", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    timers.advance(2500);
    const callsBefore = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    const pending = transport.nextQuery;
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    pending?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 5,
        lastFinished: { id: "run-5", startedAt: 8, finishedAt: 9, outcome: "completed" },
        latest: { id: "run-5", finishedAt: 9, advice: "Advice E." },
      }),
    );
    await pending?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice E." });
    expect(transport.queryCalls).toBe(callsBefore + 1);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 3,
        running: [{ id: "run-3", startedAt: 5 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice E." });
    controller.dispose();
  });

  test("G1e stale B never overwrites authoritative C", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    timers.advance(2500);
    const callsBefore = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    const staleB = transport.nextQuery;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-c",
        revision: 1,
        running: [{ id: "run-3", startedAt: 4 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 2);
    const currentC = transport.nextQuery;
    expect(currentC).not.toBe(staleB);
    staleB?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    await staleB?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    expect(transport.queryCalls).toBe(callsBefore + 2);
    currentC?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-c",
        revision: 2,
        lastFinished: { id: "run-3", startedAt: 4, finishedAt: 5, outcome: "completed" },
        latest: { id: "run-3", finishedAt: 5, advice: "Advice C." },
      }),
    );
    await currentC?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice C." });
    await Promise.resolve();
    expect(transport.queryCalls).toBe(callsBefore + 2);
    controller.dispose();
  });

  test("G1f failed confirming query stays quiet and rearms on next hint", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    timers.advance(2500);
    const callsBefore = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    const failing = transport.nextQuery;
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        lastFinished: { id: "run-2", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 4, advice: "Advice B." },
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 1);
    failing?.reject(new Error("rpc.timeout"));
    await failing?.promise.catch(() => undefined);
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice A." });
    expect(transport.queryCalls).toBe(callsBefore + 1);
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 3,
        running: [{ id: "run-3", startedAt: 5 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsBefore + 2);
    const recovery = transport.nextQuery;
    recovery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 3,
        running: [{ id: "run-3", startedAt: 5 }],
      }),
    );
    await recovery?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: true, advice: undefined });
    controller.dispose();
  });

  test("G1b foreign hint during a pending query still recovers on the next hint", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    controller.refresh();
    const callsAfterRefresh = transport.queryCalls;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        running: [{ id: "run-2", startedAt: 3 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsAfterRefresh + 1);
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 1,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState().advice).toBe("Advice A.");
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 2,
        running: [{ id: "run-3", startedAt: 5 }],
      }),
    );
    expect(transport.queryCalls).toBe(callsAfterRefresh + 2);
    controller.dispose();
  });

  test("G2 late same-epoch event never invalidates a pending epoch-establishing query", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 5,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      }),
    );
    controller.reconnect();
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 6,
        running: [{ id: "run-late", startedAt: 9 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    transport.nextQuery?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-b",
        revision: 1,
        lastFinished: { id: "run-b", startedAt: 3, finishedAt: 4, outcome: "completed" },
        latest: { id: "run-b", finishedAt: 4, advice: "Advice B." },
      }),
    );
    await transport.nextQuery?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: false, advice: "Advice B." });
    controller.dispose();
  });

  test("G2b same-epoch lower-revision query never rolls back a newer accepted event", async () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    controller.refresh();
    const stale = transport.nextQuery;
    emit(
      transport,
      "review.started",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 5,
        running: [{ id: "run-new", startedAt: 8 }],
      }),
    );
    expect(controller.getState().reviewing).toBe(true);
    stale?.resolve(
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 2,
        lastFinished: { id: "run-old", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-old", finishedAt: 2, advice: "Stale." },
      }),
    );
    await stale?.promise;
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ reviewing: true, advice: undefined });
    controller.dispose();
  });

  test("G4 duplicate redelivery preserves the original completion deadline", () => {
    const timers = createFakeTimers();
    const transport = createFakeTransport();
    const controller = createReviewController({
      sessionID: "ses_1",
      transport,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    controller.start();
    const completed = (revision: number): ReviewStatus =>
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision,
        lastFinished: { id: "run-1", startedAt: 1, finishedAt: 2, outcome: "completed" },
        latest: { id: "run-1", finishedAt: 2, advice: "Advice A." },
      });
    emit(transport, "review.finished", completed(10));
    expect(controller.getState().finished).toBe(true);
    expect(timers.pending()).toBe(1);
    timers.advance(1000);
    emit(transport, "review.finished", completed(11));
    expect(controller.getState().finished).toBe(true);
    expect(timers.pending()).toBe(1);
    timers.advance(1500);
    expect(controller.getState().finished).toBe(false);
    expect(timers.pending()).toBe(0);
    emit(transport, "review.finished", completed(12));
    expect(controller.getState().finished).toBe(false);
    expect(timers.pending()).toBe(0);
    emit(
      transport,
      "review.finished",
      runningStatus({
        sessionID: "ses_1",
        epoch: "epoch-a",
        revision: 13,
        lastFinished: { id: "run-2", startedAt: 9, finishedAt: 10, outcome: "completed" },
        latest: { id: "run-2", finishedAt: 10, advice: "Advice B." },
      }),
    );
    expect(controller.getState()).toMatchObject({ finished: true, advice: "Advice B." });
    expect(timers.pending()).toBe(1);
    controller.dispose();
  });
});
