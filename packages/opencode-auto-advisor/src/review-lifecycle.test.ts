import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReviewEventName, ReviewStatus } from "./review-contract.js";
import { createReviewLifecycle, type ReviewLifecycleOptions } from "./review-lifecycle.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: ReviewLifecycleOptions = {}) {
  let nextID = 0;
  const events: Array<{ event: ReviewEventName; snapshot: ReviewStatus }> = [];
  const errors: unknown[] = [];
  const lifecycle = createReviewLifecycle({
    clock: () => 1000,
    idFactory: () => {
      nextID += 1;
      return `run-${nextID}`;
    },
    onEventError: (error) => errors.push(error),
    ...options,
  });
  lifecycle.setEmitter((event, snapshot) => {
    events.push({ event, snapshot });
  });
  return { lifecycle, events, errors };
}

describe("review lifecycle", () => {
  test("begin records a running review synchronously and schedules the started snapshot", async () => {
    const { lifecycle, events } = harness();
    const handle = lifecycle.begin("ses_1");
    const status = lifecycle.status("ses_1");

    expect(handle).toEqual({ id: "run-1", sessionID: "ses_1", startedAt: 1000 });
    expect(status).toEqual({
      sessionID: "ses_1",
      epoch: status.epoch,
      revision: 1,
      running: [{ id: "run-1", startedAt: 1000 }],
    });
    expect(events).toEqual([]);

    await tick();
    expect(events).toEqual([{ event: "review.started", snapshot: status }]);
  });

  test("finish clears the run and exposes advice only on completion", async () => {
    const { lifecycle, events } = harness();
    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "review text");

    const status = lifecycle.status("ses_1");
    expect(status.running).toEqual([]);
    expect(status.revision).toBe(2);
    expect(status.lastFinished).toEqual({
      id: "run-1",
      startedAt: 1000,
      finishedAt: 1000,
      outcome: "completed",
    });
    expect(status.latest).toEqual({ id: "run-1", finishedAt: 1000, advice: "review text" });

    await tick();
    expect(events.map((entry) => entry.event)).toEqual(["review.started", "review.finished"]);
    expect(events[1]?.snapshot).toEqual(status);
  });

  test("failed and timeout outcomes never publish advice or provider text", async () => {
    const { lifecycle, events } = harness();
    for (const outcome of ["failed", "timeout"] as const) {
      const handle = lifecycle.begin("ses_1");
      lifecycle.finish(handle, outcome, "provider error text must not leak");
      const status = lifecycle.status("ses_1");
      expect(status.running).toEqual([]);
      expect(status.latest).toBeUndefined();
      expect(status.lastFinished?.outcome).toBe(outcome);
      expect(JSON.stringify(status)).not.toContain("provider error text");
    }
    await tick();
    expect(events[1]?.snapshot.latest).toBeUndefined();
    expect(events[3]?.snapshot.latest).toBeUndefined();
  });

  test("concurrent runs are counted and snapshots isolate canonical state", async () => {
    const { lifecycle, events } = harness();
    const first = lifecycle.begin("ses_1");
    const second = lifecycle.begin("ses_1");
    expect(lifecycle.status("ses_1").running.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    expect(lifecycle.status("ses_1").revision).toBe(2);

    await tick();
    expect(events.map((entry) => entry.event)).toEqual(["review.started", "review.started"]);
    events[0]?.snapshot.running.push({ id: "forged", startedAt: 0 });
    (events[1]?.snapshot as { revision: number }).revision = 99;
    (events[1]?.snapshot.running[0] as { id: string }).id = "forged";
    expect(lifecycle.status("ses_1").running.map((run) => run.id)).toEqual(["run-1", "run-2"]);
    expect(lifecycle.status("ses_1").revision).toBe(2);

    lifecycle.finish(first, "completed", "first advice");
    lifecycle.finish(second, "completed", "second advice");
    expect(lifecycle.status("ses_1").latest?.advice).toBe("second advice");
  });

  test("epoch is unique per lifecycle and revision stays monotonic", () => {
    const one = createReviewLifecycle();
    const two = createReviewLifecycle();
    expect(one.status("ses_1").epoch).not.toBe(two.status("ses_1").epoch);
    expect(one.status("ses_1").revision).toBe(0);

    const first = one.begin("ses_1");
    expect(one.status("ses_1").revision).toBe(1);
    one.finish(first, "failed");
    expect(one.status("ses_1").revision).toBe(2);
    const second = one.begin("ses_1");
    one.finish(second, "timeout");
    expect(one.status("ses_1").revision).toBe(4);
  });

  test("an older review finishing later never overwrites newer advice", () => {
    const { lifecycle } = harness();
    const older = lifecycle.begin("ses_1");
    const newer = lifecycle.begin("ses_1");
    lifecycle.finish(newer, "completed", "newer advice");
    lifecycle.finish(older, "completed", "older advice");
    expect(lifecycle.status("ses_1").latest).toEqual({
      id: "run-2",
      finishedAt: 1000,
      advice: "newer advice",
    });

    const first = lifecycle.begin("ses_2");
    const second = lifecycle.begin("ses_2");
    lifecycle.finish(first, "completed", "first advice");
    lifecycle.finish(second, "completed", "second advice");
    expect(lifecycle.status("ses_2").latest?.advice).toBe("second advice");
  });

  test("a failed or timed-out run clears running but keeps the previous advice", () => {
    const { lifecycle } = harness();
    const success = lifecycle.begin("ses_1");
    lifecycle.finish(success, "completed", "kept advice");
    for (const outcome of ["failed", "timeout"] as const) {
      const failed = lifecycle.begin("ses_1");
      lifecycle.finish(failed, outcome, "must not replace");
      const status = lifecycle.status("ses_1");
      expect(status.running).toEqual([]);
      expect(status.latest?.advice).toBe("kept advice");
      expect(status.lastFinished?.outcome).toBe(outcome);
    }
  });

  test("rejected, hanging, and throwing event delivery never blocks state progress", async () => {
    const errors: unknown[] = [];
    let mode: "reject" | "hang" | "throw" = "reject";
    const lifecycle = createReviewLifecycle({
      clock: () => 1,
      idFactory: () => "run-fixed",
      onEventError: (error) => errors.push(error),
    });
    lifecycle.setEmitter(() => {
      if (mode === "reject") return Promise.reject(new Error("emit rejected"));
      if (mode === "hang") return new Promise<void>(() => undefined);
      throw new Error("emit threw");
    });

    const rejected = lifecycle.begin("ses_1");
    lifecycle.finish(rejected, "completed", "rejected advice");
    expect(lifecycle.status("ses_1").latest?.advice).toBe("rejected advice");
    await tick();
    expect(errors).toHaveLength(2);

    mode = "hang";
    const hanging = lifecycle.begin("ses_2");
    lifecycle.finish(hanging, "completed", "hanging advice");
    expect(lifecycle.status("ses_2").latest?.advice).toBe("hanging advice");
    await tick();
    expect(errors).toHaveLength(2);

    mode = "throw";
    const throwing = lifecycle.begin("ses_3");
    lifecycle.finish(throwing, "completed", "sync advice");
    await tick();
    expect(errors).toHaveLength(4);
  });

  test("a throwing onEventError callback cannot break the lifecycle", async () => {
    const lifecycle = createReviewLifecycle({
      clock: () => 1,
      idFactory: () => "run-fixed",
      onEventError: () => {
        throw new Error("monitor broke");
      },
    });
    lifecycle.setEmitter(() => Promise.reject(new Error("emit rejected")));
    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "advice");
    await tick();
    expect(lifecycle.status("ses_1").latest?.advice).toBe("advice");
  });

  test("duplicate and late finishes never emit, resurrect, or change state", async () => {
    const { lifecycle, events } = harness();
    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "once");
    lifecycle.finish(handle, "completed", "again");
    expect(lifecycle.status("ses_1").latest?.advice).toBe("once");
    expect(lifecycle.status("ses_1").revision).toBe(2);

    const forgotten = lifecycle.begin("ses_2");
    await tick();
    lifecycle.forget("ses_2");
    lifecycle.finish(forgotten, "completed", "late");
    expect(lifecycle.status("ses_2")).toEqual({
      sessionID: "ses_2",
      epoch: lifecycle.status("ses_2").epoch,
      revision: 4,
      running: [],
    });

    await tick();
    expect(events.map((entry) => entry.event)).toEqual([
      "review.started",
      "review.finished",
      "review.started",
    ]);
  });

  test("dispose is idempotent, clears state, and suppresses further events", async () => {
    const { lifecycle, events } = harness();
    const handle = lifecycle.begin("ses_1");
    const before = lifecycle.status("ses_1").revision;
    lifecycle.dispose();
    lifecycle.dispose();
    lifecycle.finish(handle, "completed", "after dispose");
    const after = lifecycle.begin("ses_2");
    lifecycle.finish(after, "completed", "never");
    await tick();

    expect(events).toEqual([]);
    expect(lifecycle.status("ses_1").latest).toBeUndefined();
    expect(lifecycle.status("ses_1").running).toEqual([]);
    expect(lifecycle.status("ses_1").revision).toBe(before);
    expect(lifecycle.status("ses_2").latest).toBeUndefined();
    expect(lifecycle.status("ses_2").revision).toBe(before);
  });

  test("status of an unknown session is empty, never allocates, and never advances the revision", () => {
    const { lifecycle } = harness({ maxSessions: 1 });
    const done = lifecycle.begin("ses_keep");
    lifecycle.finish(done, "completed", "kept");
    const current = lifecycle.status("ses_keep").revision;

    for (let index = 0; index < 50; index += 1) {
      expect(lifecycle.status(`ses_ghost_${index}`).revision).toBe(current);
    }

    expect(lifecycle.status("ses_keep").latest?.advice).toBe("kept");
    const ghost = lifecycle.status("ses_ghost_0");
    expect(ghost).toEqual({
      sessionID: "ses_ghost_0",
      epoch: ghost.epoch,
      revision: current,
      running: [],
    });
  });

  test("bounds session state, evicting idle sessions but never active runs", () => {
    const { lifecycle } = harness({ maxSessions: 2 });
    const first = lifecycle.begin("ses_a");
    lifecycle.finish(first, "completed", "a advice");
    const second = lifecycle.begin("ses_b");
    lifecycle.finish(second, "completed", "b advice");
    const third = lifecycle.begin("ses_c");

    expect(lifecycle.status("ses_a").latest).toBeUndefined();
    expect(lifecycle.status("ses_b").latest?.advice).toBe("b advice");
    expect(lifecycle.status("ses_c").running.map((run) => run.id)).toEqual([third.id]);

    const { lifecycle: active } = harness({ maxSessions: 1 });
    const run = active.begin("ses_one");
    const dropped = active.begin("ses_two");
    expect(active.status("ses_one").running).toHaveLength(1);
    expect(active.status("ses_two").running).toEqual([]);
    active.finish(dropped, "completed", "dropped");
    expect(active.status("ses_two").latest).toBeUndefined();

    active.finish(run, "completed", "done");
    const replacement = active.begin("ses_three");
    expect(active.status("ses_one").latest).toBeUndefined();
    expect(active.status("ses_three").running.map((entry) => entry.id)).toEqual([replacement.id]);
  });

  test("eviction of an idle session never lets a reallocated revision regress", () => {
    const { lifecycle } = harness({ maxSessions: 2 });
    for (let index = 0; index < 3; index += 1) {
      const handle = lifecycle.begin("ses_a");
      lifecycle.finish(handle, "completed", `advice-${index}`);
    }
    expect(lifecycle.status("ses_a").revision).toBe(6);

    const other = lifecycle.begin("ses_b");
    lifecycle.finish(other, "failed");
    const churn = lifecycle.begin("ses_c");
    lifecycle.finish(churn, "failed");

    const absent = lifecycle.status("ses_a");
    expect(absent.running).toEqual([]);
    expect(absent.latest).toBeUndefined();
    expect(absent.revision).toBeGreaterThan(6);

    const fresh = lifecycle.begin("ses_a");
    expect(lifecycle.status("ses_a").revision).toBeGreaterThan(absent.revision);
    lifecycle.finish(fresh, "completed", "fresh advice");
    expect(lifecycle.status("ses_a").latest?.advice).toBe("fresh advice");
  });

  test("forget advances the revision and late finishes never resurrect or advance it", () => {
    const { lifecycle } = harness();
    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "before");
    const before = lifecycle.status("ses_1").revision;

    lifecycle.forget("ses_1");
    const absent = lifecycle.status("ses_1");
    expect(absent).toEqual({
      sessionID: "ses_1",
      epoch: absent.epoch,
      revision: before + 1,
      running: [],
    });

    lifecycle.forget("ses_1");
    lifecycle.finish(handle, "completed", "late");
    expect(lifecycle.status("ses_1")).toEqual(absent);

    const fresh = lifecycle.begin("ses_1");
    expect(lifecycle.status("ses_1").revision).toBeGreaterThan(absent.revision);
    lifecycle.finish(fresh, "completed", "fresh");
    expect(lifecycle.status("ses_1").latest?.advice).toBe("fresh");
  });

  test("active runs are never evicted and keep advancing the process-wide revision", () => {
    const { lifecycle } = harness({ maxSessions: 1 });
    const running = lifecycle.begin("ses_active");
    const dropped = lifecycle.begin("ses_other");
    expect(lifecycle.status("ses_active").running.map((entry) => entry.id)).toEqual([running.id]);

    const absent = lifecycle.status("ses_other");
    expect(absent).toEqual({
      sessionID: "ses_other",
      epoch: absent.epoch,
      revision: lifecycle.status("ses_active").revision,
      running: [],
    });

    lifecycle.finish(dropped, "completed", "dropped");
    expect(lifecycle.status("ses_active").revision).toBe(absent.revision);

    lifecycle.finish(running, "completed", "done");
    expect(lifecycle.status("ses_active").revision).toBeGreaterThan(absent.revision);
    expect(lifecycle.status("ses_other").revision).toBe(lifecycle.status("ses_active").revision);
  });

  test("delayed snapshots stay stale after eviction while fresh snapshots share the epoch", async () => {
    const { lifecycle, events } = harness({ maxSessions: 1 });
    const first = lifecycle.begin("ses_a");
    lifecycle.finish(first, "completed", "old advice");
    await tick();
    const delayed = events[1]?.snapshot;
    expect(delayed?.revision).toBe(2);

    const other = lifecycle.begin("ses_b");
    lifecycle.finish(other, "failed");
    const revived = lifecycle.begin("ses_a");
    const fresh = lifecycle.status("ses_a");

    expect(delayed?.epoch).toBe(fresh.epoch);
    expect(delayed?.revision).toBeLessThan(fresh.revision);
    expect(fresh.running.map((entry) => entry.id)).toEqual([revived.id]);
  });

  test("setEmitter(undefined) detaches delivery without touching state", async () => {
    const { lifecycle, events } = harness();
    lifecycle.setEmitter(undefined);
    const handle = lifecycle.begin("ses_1");
    lifecycle.finish(handle, "completed", "advice");
    await tick();
    expect(events).toEqual([]);
    expect(lifecycle.status("ses_1").latest?.advice).toBe("advice");
  });

  test("the lifecycle module stays free of server and tui imports", async () => {
    const source = await Bun.file(join(import.meta.dir, "review-lifecycle.ts")).text();
    expect(source).not.toContain("@opentui");
    expect(source).not.toContain("@opencode/plugin");
    const imports = source.match(/^import[\s\S]*?;$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) {
      expect(statement).toContain('from "./review-contract.js"');
    }
  });
});
