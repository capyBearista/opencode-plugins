import { describe, expect, test } from "bun:test";
import { createTelemetryStore } from "./telemetry.js";
import {
  TELEMETRY_CAP,
  TELEMETRY_PAGE_LIMIT,
  type TelemetryEventInput,
  type TelemetryStorage,
} from "./telemetry-types.js";

function memoryStorage() {
  const map = new Map<string, unknown>();
  const scans: Array<{ prefix: string; after?: string; limit?: number }> = [];
  const storage: TelemetryStorage = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async (options) => {
      scans.push(options);
      const keys = [...map.keys()]
        .filter(
          (key) =>
            key.startsWith(options.prefix) && (options.after === undefined || key > options.after),
        )
        .sort();
      const limit = options.limit ?? 100;
      const entries = keys.slice(0, limit).map((key) => ({ key, value: map.get(key) }));
      return entries.length < keys.length && entries.length > 0
        ? { entries, next: entries[entries.length - 1]?.key }
        : { entries };
    },
  };
  return { map, scans, storage };
}

const event = (overrides: Partial<TelemetryEventInput> = {}): TelemetryEventInput => ({
  sessionID: "ses_1",
  turnKey: "msg-user-1",
  mode: "observe",
  decision: "accept",
  fingerprint: "a".repeat(64),
  ...overrides,
});

describe("telemetry store", () => {
  test("caps at the confirmed 5000 events with oldest-first eviction", async () => {
    expect(TELEMETRY_CAP).toBe(5000);
    const { map, storage } = memoryStorage();
    const store = createTelemetryStore(storage, { cap: 3 });

    for (let index = 0; index < 5; index += 1) {
      await store.record(event({ turnKey: `msg-${index}` }));
    }

    const page = await store.query();
    expect(page.events.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(page.events.map((entry) => entry.turnKey)).toEqual(["msg-2", "msg-3", "msg-4"]);
    expect(await store.event(0)).toBeUndefined();
    expect(await store.event(4)).toMatchObject({ seq: 4, turnKey: "msg-4" });
    expect([...map.keys()].filter((key) => key.startsWith("evt:"))).toHaveLength(3);
  });

  test("stores the fingerprint digest and never the transcript", async () => {
    const { map, storage } = memoryStorage();
    const store = createTelemetryStore(storage);
    const digest = "b".repeat(64);

    await store.record(
      event({ fingerprint: digest, model: "jev-1.13-free", attempts: 2, latencyMs: 12 }),
    );

    const serialized = JSON.stringify([...map.values()]);
    expect(serialized).toContain(digest);
    expect(serialized).not.toContain("SECRET TRANSCRIPT");
    expect(serialized).not.toContain("transcript");
    const stored = await store.event(0);
    expect(stored).toMatchObject({
      fingerprint: digest,
      model: "jev-1.13-free",
      attempts: 2,
      latencyMs: 12,
    });
    expect(Object.keys(stored ?? {})).not.toContain("text");
  });

  test("pages scans within the host scan limit", async () => {
    const { scans, storage } = memoryStorage();
    const store = createTelemetryStore(storage, { cap: 10 });
    for (let index = 0; index < 5; index += 1) await store.record(event());

    const first = await store.query({ limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.next).toBeString();

    const second = await store.query({ after: first.next, limit: 5000 });
    expect(second.events.map((entry) => entry.seq)).toEqual([2, 3, 4]);
    expect(second.next).toBeUndefined();
    for (const scan of scans) {
      expect(scan.limit ?? 0).toBeLessThanOrEqual(1000);
      expect(scan.limit).toBeLessThanOrEqual(TELEMETRY_PAGE_LIMIT);
    }
  });

  test("keeps recording order under concurrent writes", async () => {
    const { storage } = memoryStorage();
    const store = createTelemetryStore(storage, { cap: 10 });

    await Promise.all(
      [0, 1, 2, 3, 4].map((index) => store.record(event({ turnKey: `m${index}` }))),
    );

    const page = await store.query();
    expect(page.events.map((entry) => entry.turnKey)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  test("reserves the head before writing the event so a crash cannot reuse a sequence", async () => {
    const { storage } = memoryStorage();
    const operations: string[] = [];
    const instrumented: TelemetryStorage = {
      ...storage,
      set: async (key, value) => {
        operations.push(`set:${key}`);
        await storage.set(key, value);
      },
      remove: async (key) => {
        operations.push(`remove:${key}`);
        await storage.remove(key);
      },
    };
    const store = createTelemetryStore(instrumented, { cap: 2 });

    await store.record(event());
    await store.record(event());
    await store.record(event());

    expect(operations).toEqual([
      "set:head",
      "set:evt:0000000000000000",
      "set:head",
      "set:evt:0000000000000001",
      "remove:evt:0000000000000000",
      "set:head",
      "set:evt:0000000000000002",
    ]);
  });

  test("fails open without writing the event when the head reservation fails", async () => {
    const { map, storage } = memoryStorage();
    const failing: TelemetryStorage = {
      ...storage,
      set: async (key, value) => {
        if (key === "head") throw new Error("head write failed");
        await storage.set(key, value);
      },
    };
    const store = createTelemetryStore(failing, { cap: 2 });

    await expect(store.record(event())).resolves.toBeUndefined();

    expect([...map.keys()]).toEqual([]);
  });

  test("fails open when storage writes fail", async () => {
    const storage: TelemetryStorage = {
      get: async () => {
        throw new Error("storage down");
      },
      set: async () => {
        throw new Error("storage down");
      },
      remove: async () => {
        throw new Error("storage down");
      },
      scan: async () => {
        throw new Error("storage down");
      },
    };
    const store = createTelemetryStore(storage);

    await expect(store.record(event())).resolves.toBeUndefined();
    await expect(store.query()).rejects.toThrow("storage down");
  });
});
