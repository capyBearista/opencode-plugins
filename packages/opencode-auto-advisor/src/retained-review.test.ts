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

function memoryStorage() {
  const values = new Map<string, unknown>();
  let holdWrites = false;
  let releaseWrite: (() => void) | undefined;
  let markWriteStarted: (() => void) | undefined;
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });
  let failReads = false;
  let failWrites = false;
  const storage: RetainedReviewStorage = {
    get: async (key) => {
      if (failReads) throw new Error("storage read rejected");
      return values.get(key);
    },
    set: async (key, value) => {
      if (failWrites) throw new Error("storage write rejected");
      if (holdWrites) {
        markWriteStarted?.();
        await new Promise<void>((resolve) => (releaseWrite = resolve));
      }
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
  return {
    values,
    storage,
    writeStarted,
    hold: () => {
      holdWrites = true;
    },
    release: () => {
      holdWrites = false;
      releaseWrite?.();
      releaseWrite = undefined;
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
  test("stores one latest review per session under the plugin-owned namespace", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);

    const result = await store.write(SESSION, { advice: "check the rollback", turnKey: "msg-1" });

    expect(result).toEqual({ stored: true });
    expect(retainedReviewKey(SESSION)).toBe(`${RETAINED_REVIEW_STORAGE_PREFIX}ses_1`);
    expect(memory.values.get(retainedReviewKey(SESSION))).toEqual({
      advice: "check the rollback",
      turnKey: "msg-1",
    });
    expect(await store.read(SESSION)).toEqual({ advice: "check the rollback", turnKey: "msg-1" });
  });

  test("a newer review replaces the older one", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);

    await store.write(SESSION, { advice: "first review", turnKey: "msg-1" });
    await store.write(SESSION, { advice: "second review", turnKey: "msg-2" });

    expect(memory.values.size).toBe(1);
    expect(await store.read(SESSION)).toEqual({ advice: "second review", turnKey: "msg-2" });
  });

  test("oversized advice is refused without writing or truncating", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    const oversize = "x".repeat(RETAINED_REVIEW_MAX_CHARS + 1);

    const result = await store.write(SESSION, { advice: oversize, turnKey: "msg-1" });

    expect(result).toEqual({ stored: false, reason: "oversize" });
    expect(memory.values.size).toBe(0);
    expect(await store.read(SESSION)).toBeUndefined();
  });

  test("remove deletes the key and blocks later writes", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    await store.write(SESSION, { advice: "old review", turnKey: "msg-1" });

    await store.remove(SESSION);

    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
    expect(await store.read(SESSION)).toBeUndefined();
    expect(await store.write(SESSION, { advice: "late review", turnKey: "msg-2" })).toEqual({
      stored: false,
      reason: "deleted",
    });
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
  });

  test("an in-flight write after remove does not persist", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    memory.hold();

    const write = store.write(SESSION, { advice: "in-flight review", turnKey: "msg-1" });
    await memory.writeStarted;
    const removal = store.remove(SESSION);
    memory.release();

    expect(await write).toEqual({ stored: true });
    await removal;
    expect(memory.values.has(retainedReviewKey(SESSION))).toBe(false);
    expect(await store.read(SESSION)).toBeUndefined();
  });

  test("malformed stored state reads as absent", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    memory.values.set(retainedReviewKey(SESSION), { advice: 42, turnKey: null });

    expect(await store.read(SESSION)).toBeUndefined();
  });

  test("storage failures propagate so callers can fail open", async () => {
    const memory = memoryStorage();
    const store = createRetainedReviewStore(memory.storage);
    memory.failReads();
    memory.failWrites();

    await expect(store.read(SESSION)).rejects.toThrow("storage read rejected");
    await expect(store.write(SESSION, { advice: "review", turnKey: "msg-1" })).rejects.toThrow(
      "storage write rejected",
    );
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
