import { describe, expect, test } from "bun:test";
import type { SessionID } from "./messages.js";
import {
  createRetainedReviewStore,
  formatRetainedReview,
  RETAINED_REVIEW_HEADER,
  RETAINED_REVIEW_MAX_CHARS,
  RETAINED_REVIEW_STORAGE_PREFIX,
  type RetainedReviewStorage,
  retainedReviewEntry,
  retainedReviewKey,
} from "./retained-review.js";

const SESSION = "ses_1" as SessionID;
const OTHER = "ses_2" as SessionID;

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function memoryStorage() {
  const values = new Map<string, unknown>();
  const held = new Map<string, Promise<void>>();
  const releases: Array<() => void> = [];
  let failReads = false;
  let failWrites = false;
  const storage: RetainedReviewStorage = {
    get: async (key) => {
      if (failReads) throw new Error("storage read rejected");
      return values.get(key);
    },
    set: async (key, value) => {
      if (failWrites) throw new Error("storage write rejected");
      const gate = held.get(key);
      if (gate) await gate;
      values.set(key, value);
    },
    remove: async (key) => {
      const gate = held.get(key);
      if (gate) await gate;
      values.delete(key);
    },
  };
  return {
    values,
    storage,
    hold: (key: string) => {
      held.set(
        key,
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
      );
    },
    release: () => {
      for (const release of releases.splice(0)) release();
      held.clear();
    },
    failReads: () => {
      failReads = true;
    },
    failWrites: () => {
      failWrites = true;
    },
  };
}

describe("retained review store", () => {
  test("keeps the latest review in memory immediately and persists it under the plugin namespace", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);

    const result = store.replace(SESSION, { advice: "check the rollback", turnKey: "msg-1" });

    expect(result).toEqual({ stored: true });
    expect(await store.read(SESSION)).toEqual({ advice: "check the rollback", turnKey: "msg-1" });
    await settle();
    expect(retainedReviewKey(SESSION)).toBe(`${RETAINED_REVIEW_STORAGE_PREFIX}ses_1`);
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "check the rollback",
      turnKey: "msg-1",
    });
  });

  test("a newer review supersedes the older one without waiting for storage", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "first review", turnKey: "msg-1" });
    await settle();

    memory.hold(retainedReviewKey(SESSION));
    expect(store.replace(SESSION, { advice: "second review", turnKey: "msg-2" })).toEqual({
      stored: true,
    });

    expect(await store.read(SESSION)).toEqual({ advice: "second review", turnKey: "msg-2" });
    memory.release();
    await settle();
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "second review",
      turnKey: "msg-2",
    });
  });

  test("oversized advice tombstones the review and removes the durable entry", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();
    const oversize = "x".repeat(RETAINED_REVIEW_MAX_CHARS + 1);

    expect(store.replace(SESSION, { advice: oversize, turnKey: "msg-2" })).toEqual({
      stored: false,
      reason: "oversize",
    });

    expect(await store.read(SESSION)).toBeUndefined();
    await settle();
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
    expect(await store.read(SESSION)).toBeUndefined();
  });

  test("empty advice never replaces an existing review", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();

    expect(store.replace(SESSION, { advice: "", turnKey: "msg-2" })).toEqual({
      stored: false,
      reason: "empty",
    });
    expect(await store.read(SESSION)).toEqual({ advice: "old review", turnKey: "msg-1" });
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "old review",
      turnKey: "msg-1",
    });
  });

  test("whitespace-only advice is treated as empty", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();

    expect(store.replace(SESSION, { advice: "   \n  ", turnKey: "msg-2" })).toEqual({
      stored: false,
      reason: "empty",
    });
    expect(await store.read(SESSION)).toEqual({ advice: "old review", turnKey: "msg-1" });
  });

  test("a failed durable write keeps the new review in memory", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();
    memory.failWrites();

    expect(store.replace(SESSION, { advice: "new review", turnKey: "msg-2" })).toEqual({
      stored: true,
    });
    await settle();

    expect(await store.read(SESSION)).toEqual({ advice: "new review", turnKey: "msg-2" });
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "old review",
      turnKey: "msg-1",
    });
  });

  test("clear tombstones the latest review and removes durable state", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();

    store.clear(SESSION);

    expect(await store.read(SESSION)).toBeUndefined();
    await settle();
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
  });

  test("forget drops the overlay and durable state while later work stays unblocked", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });
    await settle();

    store.forget(SESSION);

    expect(await store.read(SESSION)).toBeUndefined();
    await settle();
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
    expect(store.replace(SESSION, { advice: "fresh review", turnKey: "msg-2" })).toEqual({
      stored: true,
    });
    expect(await store.read(SESSION)).toEqual({ advice: "fresh review", turnKey: "msg-2" });
  });

  test("one session's blocked storage never stalls another session's retained work", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    memory.hold(retainedReviewKey(SESSION));

    expect(store.replace(SESSION, { advice: "blocked review", turnKey: "msg-1" })).toEqual({
      stored: true,
    });
    expect(store.replace(OTHER, { advice: "other review", turnKey: "msg-1" })).toEqual({
      stored: true,
    });
    await settle();

    expect(await store.read(OTHER)).toEqual({ advice: "other review", turnKey: "msg-1" });
    expect(memory.values.get(retainedReviewKey(OTHER))).toEqual({
      advice: "other review",
      turnKey: "msg-1",
    });
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);

    memory.release();
    await settle();
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "blocked review",
      turnKey: "msg-1",
    });
  });

  test("malformed durable state reads as absent", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    const malformed = [
      { advice: "", turnKey: "msg-1" },
      { advice: "x".repeat(RETAINED_REVIEW_MAX_CHARS + 1), turnKey: "msg-1" },
      { advice: "review", turnKey: "" },
      { advice: "review" },
      { advice: 42, turnKey: "msg-1" },
      { advice: "review", turnKey: null },
      [],
      null,
    ];

    for (const value of malformed) {
      memory.values.set(retainedReviewKey(SESSION), value);
      expect(await store.read(SESSION)).toBeUndefined();
    }
  });

  test("storage read failures read as absent", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    memory.failReads();

    expect(await store.read(SESSION)).toBeUndefined();
  });

  test("dispose drops memory and refuses later replacement", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    store.replace(SESSION, { advice: "old review", turnKey: "msg-1" });

    store.dispose();

    expect(await store.read(SESSION)).toBeUndefined();
    expect(store.replace(SESSION, { advice: "late review", turnKey: "msg-2" })).toEqual({
      stored: false,
      reason: "deleted",
    });
  });
});

describe("retained review framing", () => {
  test("frames the review as historical reviewer guidance, not a user instruction", () => {
    const text = formatRetainedReview({ advice: "recheck the migration", turnKey: "msg-9" });

    expect(text).toStartWith(RETAINED_REVIEW_HEADER);
    expect(text).toContain("recheck the migration");
    expect(text).toContain("msg-9");
    expect(text).toContain("historical");
    expect(text).toContain("not a new user instruction");
  });

  test("builds one system entry for a review and nothing without one", () => {
    const entry = retainedReviewEntry({ advice: "recheck", turnKey: "msg-1" });

    expect(entry?.role).toBe("system");
    expect(entry?.text).toBe(formatRetainedReview({ advice: "recheck", turnKey: "msg-1" }));
    expect(retainedReviewEntry(undefined)).toBeUndefined();
  });
});
