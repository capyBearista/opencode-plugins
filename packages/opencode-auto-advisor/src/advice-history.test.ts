import { describe, expect, test } from "bun:test";
import {
  ADVICE_HISTORY_MAX_ADVICE_CHARS,
  ADVICE_HISTORY_MAX_RECORDS_PER_SESSION,
  ADVICE_HISTORY_MAX_SESSION_CHARS,
  ADVICE_HISTORY_MAX_SESSIONS,
  ADVICE_HISTORY_STORAGE_KEY,
  type AdviceCommitInput,
  type AdviceHistory,
  type AdviceHistoryJson,
  AdviceHistoryStateError,
  type AdviceHistoryStorage,
  type AdviceRecord,
  type AdviceReservation,
  createAdviceHistory,
} from "./advice-history.js";
import type { SessionID } from "./messages.js";

const SESSION = "ses_1" as SessionID;
const OTHER = "ses_2" as SessionID;

function memoryStorage() {
  const map = new Map<string, unknown>();
  let writeFailure: Error | undefined;
  let readFailure: Error | undefined;
  const storage: AdviceHistoryStorage = {
    get: async (key) => {
      if (readFailure) throw readFailure;
      return map.get(key) as AdviceHistoryJson | undefined;
    },
    set: async (key, value) => {
      if (writeFailure) throw writeFailure;
      map.set(key, value);
    },
  };
  return {
    map,
    storage,
    failWrites: (error: Error) => {
      writeFailure = error;
    },
    recoverWrites: () => {
      writeFailure = undefined;
    },
    failReads: (error: Error) => {
      readFailure = error;
    },
    recoverReads: () => {
      readFailure = undefined;
    },
  };
}

const commitInput = (overrides: Partial<AdviceCommitInput> = {}): AdviceCommitInput => ({
  turnKey: "msg-user-1",
  materialFingerprint: "fp-1",
  advice: "review advice",
  ...overrides,
});

async function reserve(history: AdviceHistory, sessionID: SessionID): Promise<AdviceReservation> {
  const reservation = await history.reserve(sessionID);
  if (reservation === undefined) throw new Error("expected an available reservation");
  return reservation;
}

async function commit(
  history: AdviceHistory,
  reservation: AdviceReservation,
  input: AdviceCommitInput,
): Promise<AdviceRecord> {
  const record = await history.commit(reservation, input);
  if (record === undefined) throw new Error("expected a committed record");
  return record;
}

const storedRecord = (id: string, sequence: number): AdviceRecord => ({
  id,
  sequence,
  turnKey: `msg-${sequence}`,
  materialFingerprint: `fp-${sequence}`,
  advice: `advice-${sequence}`,
});

const tinyLimits = {
  maxSessions: 2,
  maxRecordsPerSession: 2,
  maxAdviceChars: 4,
  maxSessionChars: 8,
};

describe("advice history store", () => {
  test("pins the approved internal caps", () => {
    expect(ADVICE_HISTORY_MAX_SESSIONS).toBe(64);
    expect(ADVICE_HISTORY_MAX_RECORDS_PER_SESSION).toBe(16);
    expect(ADVICE_HISTORY_MAX_ADVICE_CHARS).toBe(32_768);
    expect(ADVICE_HISTORY_MAX_SESSION_CHARS).toBe(131_072);
  });

  test("commits a record and returns it from a later get", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const reservation = await reserve(history, SESSION);
    const record = await commit(
      history,
      reservation,
      commitInput({ turnKey: "msg-user-1", advice: "check the migration ordering" }),
    );

    expect(record.turnKey).toBe("msg-user-1");
    expect(record.advice).toBe("check the migration ordering");
    expect(record.id).toBeString();
    expect(record.sequence).toBe(1);
    expect(await history.get(SESSION)).toEqual([record]);
    expect(await history.get(OTHER)).toEqual([]);
  });

  test("a new factory over the same storage reconstructs identical records", async () => {
    const { storage } = memoryStorage();
    const first = createAdviceHistory(storage);
    const a = await commit(first, await reserve(first, SESSION), commitInput({ advice: "alpha" }));
    const b = await commit(
      first,
      await reserve(first, SESSION),
      commitInput({ turnKey: "msg-user-2", advice: "beta" }),
    );

    const reopened = createAdviceHistory(storage);
    expect(await reopened.get(SESSION)).toEqual([a, b]);
    const c = await commit(
      reopened,
      await reserve(reopened, SESSION),
      commitInput({ turnKey: "msg-user-3", advice: "gamma" }),
    );
    expect(c.sequence).toBe(3);
  });

  test("stores only the structured record fields, never canonical raw state", async () => {
    const { map, storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "SECRET-ADVICE" }),
    );

    const persisted = map.get(ADVICE_HISTORY_STORAGE_KEY) as {
      version: number;
      nextSequence: number;
      sessions: Array<{ sessionID: string; records: Array<Record<string, unknown>> }>;
    };
    expect(Object.keys(persisted).sort()).toEqual(["nextSequence", "sessions", "version"]);
    expect(persisted.version).toBe(1);
    expect(persisted.nextSequence).toBe(2);
    expect(persisted.sessions).toHaveLength(1);
    expect(persisted.sessions[0]?.sessionID).toBe(SESSION);
    expect(Object.keys(persisted.sessions[0]?.records[0] ?? {}).sort()).toEqual([
      "advice",
      "id",
      "materialFingerprint",
      "sequence",
      "turnKey",
    ]);
    expect(persisted.sessions[0]?.records[0]?.advice).toBe("SECRET-ADVICE");
  });

  test("assigns unique ids and monotonically increasing sequences", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const records: AdviceRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      records.push(
        await commit(
          history,
          await reserve(history, SESSION),
          commitInput({ advice: `a${index}` }),
        ),
      );
    }

    expect(new Set(records.map((record) => record.id)).size).toBe(3);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(records[0])).toBe(true);
  });

  test("keeps concurrent reservations and commits without duplicates or lost updates", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage, {
      limits: { maxSessions: 8, maxRecordsPerSession: 8, maxAdviceChars: 64, maxSessionChars: 512 },
    });
    const sessions = ["ses_1", "ses_2", "ses_3"].map((id) => id as SessionID);
    const reservations = await Promise.all(
      sessions.flatMap((sessionID) => [history.reserve(sessionID), history.reserve(sessionID)]),
    );
    const commits = await Promise.all(
      reservations.map((reservation, index) =>
        history.commit(
          reservation as AdviceReservation,
          commitInput({ turnKey: `msg-${index}`, advice: `advice-${index}` }),
        ),
      ),
    );

    expect(commits.every((record) => record !== undefined)).toBe(true);
    const all = (await Promise.all(sessions.map((sessionID) => history.get(sessionID)))).flat();
    expect(all).toHaveLength(6);
    expect(new Set(all.map((record) => record.id)).size).toBe(6);
    expect(all.map((record) => record.sequence).sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  test("a reservation from another store is not a valid grant", async () => {
    const { storage } = memoryStorage();
    const first = createAdviceHistory(storage);
    const second = createAdviceHistory(storage);
    const reservation = await reserve(first, SESSION);

    await expect(second.commit(reservation, commitInput())).resolves.toBeUndefined();
    second.release(reservation);
    expect(await first.commit(reservation, commitInput())).toBeDefined();
  });

  test("invalid commit input commits nothing and releases the reservation", async () => {
    const { map, storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const reservation = await reserve(history, SESSION);
    await expect(history.commit(reservation, commitInput({ advice: "" }))).resolves.toBeUndefined();
    expect(await history.get(SESSION)).toEqual([]);
    expect(map.has(ADVICE_HISTORY_STORAGE_KEY)).toBe(false);

    const recovered = await commit(history, await reserve(history, SESSION), commitInput());
    expect(recovered.sequence).toBe(1);
  });

  test("retires exact ids and preserves records that were not captured", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const a = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "alpha" }),
    );
    const b = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "beta" }),
    );

    await history.retire(SESSION, [a.id, "adv_missing"]);
    expect(await history.get(SESSION)).toEqual([b]);
    await history.retire(OTHER, [b.id]);
    expect(await history.get(SESSION)).toEqual([b]);
  });

  test("a failed storage write preserves earlier state and rejects", async () => {
    const { map, storage, failWrites, recoverWrites } = memoryStorage();
    const history = createAdviceHistory(storage);
    const a = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "alpha" }),
    );

    failWrites(new Error("storage write failed"));
    const reservation = await reserve(history, SESSION);
    await expect(history.commit(reservation, commitInput({ advice: "beta" }))).rejects.toThrow(
      "storage write failed",
    );
    expect(await history.get(SESSION)).toEqual([a]);
    const reopened = createAdviceHistory(storage);
    expect(await reopened.get(SESSION)).toEqual([a]);

    recoverWrites();
    const recovered = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "gamma" }),
    );
    expect(recovered.sequence).toBe(2);
    expect(map.get(ADVICE_HISTORY_STORAGE_KEY)).toBeDefined();
  });

  test("a storage read failure rejects without resetting state", async () => {
    const { storage, failReads, recoverReads } = memoryStorage();
    const history = createAdviceHistory(storage);
    failReads(new Error("storage read failed"));

    await expect(history.get(SESSION)).rejects.toThrow("storage read failed");
    await expect(history.reserve(SESSION)).rejects.toThrow("storage read failed");

    recoverReads();
    const reservation = await reserve(history, SESSION);
    expect(await commit(history, reservation, commitInput({ advice: "alpha" }))).toBeDefined();
  });

  test("invalid stored state fails safely instead of resetting", async () => {
    const first = memoryStorage();
    const corruptVersion = { version: 2, nextSequence: 1, sessions: [] };
    first.map.set(ADVICE_HISTORY_STORAGE_KEY, corruptVersion);
    const history = createAdviceHistory(first.storage);
    await expect(history.get(SESSION)).rejects.toBeInstanceOf(AdviceHistoryStateError);
    await expect(history.reserve(SESSION)).rejects.toBeInstanceOf(AdviceHistoryStateError);
    expect(first.map.get(ADVICE_HISTORY_STORAGE_KEY)).toBe(corruptVersion);

    const second = memoryStorage();
    const duplicateIDs = {
      version: 1,
      nextSequence: 3,
      sessions: [
        { sessionID: "ses_1", records: [storedRecord("adv_a", 1)] },
        { sessionID: "ses_2", records: [storedRecord("adv_a", 2)] },
      ],
    };
    second.map.set(ADVICE_HISTORY_STORAGE_KEY, duplicateIDs);
    const other = createAdviceHistory(second.storage);
    await expect(other.get(SESSION)).rejects.toBeInstanceOf(AdviceHistoryStateError);
    expect(second.map.get(ADVICE_HISTORY_STORAGE_KEY)).toBe(duplicateIDs);
  });

  test("restored records expose only the structured fields", async () => {
    const { map, storage } = memoryStorage();
    map.set(ADVICE_HISTORY_STORAGE_KEY, {
      version: 1,
      nextSequence: 2,
      sessions: [
        {
          sessionID: SESSION,
          records: [
            {
              ...storedRecord("adv_a", 1),
              rawState: "SECRET-RAW-STATE",
              reasoning: "hidden reasoning",
            },
          ],
        },
      ],
    });
    const history = createAdviceHistory(storage);

    const records = await history.get(SESSION);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      "advice",
      "id",
      "materialFingerprint",
      "sequence",
      "turnKey",
    ]);
    expect(JSON.stringify(records)).not.toContain("SECRET-RAW-STATE");
  });

  test("forget invalidates live handles before its persist await so a late commit cannot resurrect", async () => {
    const { map, storage } = memoryStorage();
    let gate: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let gated = false;
    const slow: AdviceHistoryStorage = {
      get: storage.get,
      set: async (key, value) => {
        if (gated) {
          gated = false;
          writeStarted?.();
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
        }
        await storage.set(key, value);
      },
    };
    const history = createAdviceHistory(slow);
    await commit(history, await reserve(history, SESSION), commitInput({ advice: "seed" }));

    const reservation = await reserve(history, SESSION);
    gated = true;
    const late = history.commit(reservation, commitInput({ advice: "late" }));
    await started;
    const forgetting = history.forget(SESSION);
    gate?.();
    await late;
    await forgetting;

    expect(await history.get(SESSION)).toEqual([]);
    const persisted = map.get(ADVICE_HISTORY_STORAGE_KEY) as { sessions: readonly unknown[] };
    expect(persisted.sessions).toEqual([]);
  });

  test("queued operations after forget do not restore the old state", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    await commit(history, await reserve(history, SESSION), commitInput({ advice: "seed" }));

    const lateReservation = history.reserve(SESSION);
    const forgetting = history.forget(SESSION);
    const lateCommit = lateReservation.then((reservation) =>
      reservation ? history.commit(reservation, commitInput({ advice: "late" })) : undefined,
    );

    await forgetting;
    await expect(lateCommit).resolves.toBeUndefined();
    expect(await history.get(SESSION)).toEqual([]);
    const reopened = createAdviceHistory(storage);
    expect(await reopened.get(SESSION)).toEqual([]);
  });

  test("dispose invalidates prior handles and performs no further writes", async () => {
    const { map, storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const reservation = await reserve(history, SESSION);
    history.dispose();

    await expect(
      history.commit(reservation, commitInput({ advice: "late" })),
    ).resolves.toBeUndefined();
    await expect(history.reserve(SESSION)).resolves.toBeUndefined();
    await history.retire(SESSION, ["adv_any"]);
    await history.forget(SESSION);
    expect(map.has(ADVICE_HISTORY_STORAGE_KEY)).toBe(false);
  });

  test("caps sessions, records, and aggregate characters without evicting", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage, { limits: tinyLimits });
    const a = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "aaaa" }),
    );
    const b = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "bbbb" }),
    );
    expect(await history.get(SESSION)).toEqual([a, b]);

    await expect(history.reserve(SESSION)).resolves.toBeUndefined();
    expect(await history.get(SESSION)).toEqual([a, b]);

    const secondSession = await history.reserve(OTHER);
    expect(secondSession).toBeDefined();
    await expect(history.reserve("ses_3" as SessionID)).resolves.toBeUndefined();

    await history.retire(SESSION, [a.id, b.id]);
    expect(await history.reserve(SESSION)).toBeDefined();
  });

  test("reserves the worst-case advice slot so concurrent reservations cannot oversubscribe", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage, {
      limits: { maxSessions: 4, maxRecordsPerSession: 4, maxAdviceChars: 4, maxSessionChars: 4 },
    });

    const [first, second] = await Promise.all([history.reserve(SESSION), history.reserve(SESSION)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const granted = first ?? second;
    if (granted === undefined) throw new Error("expected a reservation");
    history.release(granted);
    history.release(granted);
    expect(await history.reserve(SESSION)).toBeDefined();
  });

  test("release restores capacity", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage, {
      limits: { maxSessions: 4, maxRecordsPerSession: 4, maxAdviceChars: 4, maxSessionChars: 4 },
    });
    const reservation = await reserve(history, SESSION);
    await expect(history.reserve(SESSION)).resolves.toBeUndefined();

    history.release(reservation);
    expect(await history.reserve(SESSION)).toBeDefined();
  });

  test("oversized advice commits nothing and returns undefined", async () => {
    const { map, storage } = memoryStorage();
    const history = createAdviceHistory(storage, {
      limits: { maxAdviceChars: 4, maxSessionChars: 8 },
    });
    const reservation = await reserve(history, SESSION);
    await expect(
      history.commit(reservation, commitInput({ advice: "12345" })),
    ).resolves.toBeUndefined();
    expect(await history.get(SESSION)).toEqual([]);
    expect(map.has(ADVICE_HISTORY_STORAGE_KEY)).toBe(false);

    const exact = await commit(
      history,
      await reserve(history, SESSION),
      commitInput({ advice: "1234" }),
    );
    expect(exact.advice).toBe("1234");
  });

  test("bounds a session at four maximum-size advices by default", async () => {
    const { storage } = memoryStorage();
    const history = createAdviceHistory(storage);
    const largest = "x".repeat(ADVICE_HISTORY_MAX_ADVICE_CHARS);
    for (let index = 0; index < 4; index += 1) {
      await commit(history, await reserve(history, SESSION), commitInput({ advice: largest }));
    }

    await expect(history.reserve(SESSION)).resolves.toBeUndefined();
    expect(await history.get(SESSION)).toHaveLength(4);
  });
});
