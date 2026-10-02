import { describe, expect, test } from "bun:test";
import {
  readCompactionEndedEvent,
  readCompactionFailedEvent,
  registerAdviceCompaction,
} from "./advice-compaction.js";
import { type AdviceHistory, createAdviceHistory } from "./advice-history.js";
import { formatCompactionReviews } from "./advice-history-format.js";
import type { EligibilitySources } from "./eligibility.js";
import type { SessionID } from "./messages.js";

const SESSION = "ses_1" as SessionID;
const FINGERPRINT = "f".repeat(64);

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

async function seeded(advices: readonly string[]): Promise<AdviceHistory> {
  const history = createAdviceHistory(memoryStorage());
  for (const advice of advices) {
    const grant = await history.reserve(SESSION);
    if (!grant) throw new Error("seed reservation failed");
    await history.commit(grant, { turnKey: "turn-1", materialFingerprint: FINGERPRINT, advice });
  }
  return history;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function gatedHistory(history: AdviceHistory, gates: Gate[]): AdviceHistory {
  return {
    ...history,
    get: async (sessionID: SessionID) => {
      const held = gates.shift();
      if (held) await held.promise;
      return history.get(sessionID);
    },
  };
}

function fakeSession(
  options: {
    readonly parentID?: string;
    readonly getFails?: boolean;
    readonly gates?: Gate[];
  } = {},
) {
  let callback: ((event: unknown) => Promise<void> | void) | undefined;
  let disposals = 0;
  const session = {
    hook: async (name: string, cb: (event: unknown) => Promise<void> | void) => {
      if (name !== "compaction") throw new Error(`unexpected hook ${name}`);
      callback = cb;
      return {
        dispose: async () => {
          disposals += 1;
        },
      };
    },
    get: async () => {
      const held = options.gates?.shift();
      if (held) await held.promise;
      if (options.getFails) throw new Error("session store down");
      return { parentID: options.parentID, permissions: [] };
    },
  };
  const eligibility: EligibilitySources = {
    session,
    agent: { get: async () => ({ data: { permissions: [] } }) },
  };
  return {
    session,
    eligibility,
    disposals: () => disposals,
    fire: async (event: unknown) => {
      await callback?.(event);
    },
  };
}

function compactionEvent(extra: Record<string, unknown> = {}) {
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [] as Array<{ type: string; text: string }>,
    messages: [],
    options: {},
    ...extra,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("advice compaction retention", () => {
  test("pushes the retention block into the compaction request system", async () => {
    const history = await seeded(["recheck the migration"]);
    const fake = fakeSession();
    await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent();

    await fake.fire(event);

    expect(event.system).toHaveLength(1);
    expect(event.system[0]?.type).toBe("text");
    expect(event.system[0]?.text).toContain("[AUTO_ADVISOR_RETAINED_REVIEWS_V1]");
    expect(event.system[0]?.text).toContain("recheck the migration");
    expect(event.system[0]?.text).not.toContain("advisor()");
  });

  test("skips parented sessions and failing lookups without mutating the request", async () => {
    const history = await seeded(["review"]);
    const parented = fakeSession({ parentID: "ses_parent" });
    await registerAdviceCompaction(parented.session as never, {
      history,
      eligibility: parented.eligibility,
    });
    const parentedEvent = compactionEvent();

    await parented.fire(parentedEvent);
    expect(parentedEvent.system).toHaveLength(0);

    const failing = fakeSession({ getFails: true });
    await registerAdviceCompaction(failing.session as never, {
      history,
      eligibility: failing.eligibility,
    });
    const failingEvent = compactionEvent();

    await failing.fire(failingEvent);
    expect(failingEvent.system).toHaveLength(0);
  });

  test("skips sessions without retained records", async () => {
    const history = createAdviceHistory(memoryStorage());
    const fake = fakeSession();
    await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent();

    await fake.fire(event);

    expect(event.system).toHaveLength(0);
  });

  test("extends a preexisting hook result without replacing the compactor", async () => {
    const history = await seeded(["recheck the migration"]);
    const fake = fakeSession();
    await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({
      result: { summary: "native summary", metadata: { source: "compactor" } },
    });

    await fake.fire(event);

    const result = event.result as { summary: string; metadata: Record<string, unknown> };
    expect(result.summary).toContain("native summary");
    expect(result.summary).toContain("[AUTO_ADVISOR_RETAINED_REVIEWS_V1]");
    expect(result.summary).toContain("recheck the migration");
    expect(result.metadata).toEqual({ source: "compactor" });
  });

  test("does not duplicate a block already present in a preexisting result", async () => {
    const history = await seeded(["recheck the migration"]);
    const fake = fakeSession();
    await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const block = formatCompactionReviews(await history.get(SESSION));
    const event = compactionEvent({ result: { summary: `preexisting\n\n${block}` } });

    await fake.fire(event);

    const result = event.result as { summary: string };
    expect(result.summary).toBe(`preexisting\n\n${block}`);
  });

  test("retires only captured records proven absorbed by the ended text", async () => {
    const history = await seeded(["first review", "second review"]);
    const captured = await history.get(SESSION);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());

    registration.ended(SESSION, formatCompactionReviews([captured[0] as never]));
    await tick();

    expect([...registration.absorbed(SESSION)]).toEqual([captured[0]?.id]);
    const remaining = await history.get(SESSION);
    expect(remaining.map((record) => record.id)).toEqual([captured[1]?.id]);
  });

  test("preserves records when the ended text paraphrases or omits the payload", async () => {
    const history = await seeded(["keep me"]);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());

    registration.ended(SESSION, "the advisor suggested checking the migration path");
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("preserves records on failed compaction and ignores duplicate ended events", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());
    registration.failed(SESSION);
    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);

    await fake.fire(compactionEvent());
    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();
    expect(registration.absorbed(SESSION).size).toBe(1);

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();
    expect(registration.absorbed(SESSION).size).toBe(1);
  });

  test("new records committed after capture survive retirement", async () => {
    const history = await seeded(["captured review"]);
    const captured = await history.get(SESSION);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());

    const grant = await history.reserve(SESSION);
    if (!grant) throw new Error("reservation failed");
    await history.commit(grant, {
      turnKey: "turn-2",
      materialFingerprint: FINGERPRINT,
      advice: "later review",
    });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    const remaining = await history.get(SESSION);
    expect(remaining.map((record) => record.advice)).toEqual(["later review"]);
  });

  test("forget clears pending capture and absorption state", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());
    registration.forget(SESSION);

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("parses only exact public compaction event payloads", () => {
    expect(
      readCompactionEndedEvent({
        type: "session.compaction.ended",
        data: { sessionID: "ses_1", text: "summary" },
      }),
    ).toEqual({ sessionID: "ses_1", text: "summary" });
    expect(
      readCompactionEndedEvent({ type: "session.compaction.ended", data: {} }),
    ).toBeUndefined();
    expect(
      readCompactionEndedEvent({ type: "session.compaction.failed", data: {} }),
    ).toBeUndefined();
    expect(readCompactionEndedEvent(undefined)).toBeUndefined();

    expect(
      readCompactionFailedEvent({
        type: "session.compaction.failed",
        data: { sessionID: "ses_1" },
      }),
    ).toBe("ses_1");
    expect(
      readCompactionFailedEvent({ type: "session.compaction.ended", data: {} }),
    ).toBeUndefined();
    expect(
      readCompactionFailedEvent({ type: "session.deleted", data: { sessionID: "s" } }),
    ).toBeUndefined();
  });
});

describe("advice compaction preparation lifetime", () => {
  test("forget during a held eligibility lookup discards the preparation", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const held = gate();
    const fake = fakeSession({ gates: [held] });
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({ result: { summary: "native summary" } });

    const firing = fake.fire(event);
    registration.forget(SESSION);
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("forget during a held history read discards the preparation", async () => {
    const base = await seeded(["keep me"]);
    const captured = await base.get(SESSION);
    const held = gate();
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history: gatedHistory(base, [held]),
      eligibility: fake.eligibility,
    });
    const event = compactionEvent();

    const firing = fake.fire(event);
    await tick();
    registration.forget(SESSION);
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await base.get(SESSION)).toHaveLength(1);
  });

  test("dispose during a held history read discards the preparation", async () => {
    const base = await seeded(["keep me"]);
    const captured = await base.get(SESSION);
    const held = gate();
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history: gatedHistory(base, [held]),
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({ result: { summary: "native summary" } });

    const firing = fake.fire(event);
    await tick();
    await registration.dispose();
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await base.get(SESSION)).toHaveLength(1);
  });

  test("failed during preparation invalidates the in-flight capture", async () => {
    const base = await seeded(["keep me"]);
    const captured = await base.get(SESSION);
    const held = gate();
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history: gatedHistory(base, [held]),
      eligibility: fake.eligibility,
    });
    const event = compactionEvent();

    const firing = fake.fire(event);
    await tick();
    registration.failed(SESSION);
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await base.get(SESSION)).toHaveLength(1);
  });

  test("a hook invoked after dispose is inert", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await registration.dispose();
    await registration.dispose();
    registration.forget(SESSION);
    registration.failed(SESSION);

    const event = compactionEvent({ result: { summary: "native summary" } });
    await fake.fire(event);

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("a forgotten preparation cannot clobber a newer capture for the same session", async () => {
    const history = await seeded(["first review"]);
    const held = gate();
    const fake = fakeSession({ gates: [held] });
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const stale = compactionEvent({ result: { summary: "stale summary" } });

    const staleFiring = fake.fire(stale);
    registration.forget(SESSION);

    const fresh = compactionEvent();
    await fake.fire(fresh);

    held.release();
    await staleFiring;

    expect(stale.system).toHaveLength(0);
    expect(stale.result).toEqual({ summary: "stale summary" });
    expect(fresh.system).toHaveLength(1);
    expect(fresh.system[0]?.text).toContain("first review");

    const captured = await history.get(SESSION);
    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(1);
    expect(await history.get(SESSION)).toHaveLength(0);
  });

  test("cleanup calls are idempotent and a later capture still works", async () => {
    const history = await seeded(["keep me"]);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    await fake.fire(compactionEvent());

    registration.forget(SESSION);
    registration.forget(SESSION);
    registration.failed(SESSION);
    registration.failed(SESSION);

    const event = compactionEvent();
    await fake.fire(event);
    expect(event.system).toHaveLength(1);

    const captured = await history.get(SESSION);
    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();
    expect(registration.absorbed(SESSION).size).toBe(1);
  });
});

async function seedRecord(
  history: AdviceHistory,
  sessionID: SessionID,
  advice: string,
): Promise<void> {
  const grant = await history.reserve(sessionID);
  if (!grant) throw new Error("seed reservation failed");
  await history.commit(grant, { turnKey: "turn-1", materialFingerprint: FINGERPRINT, advice });
}

describe("compaction invalidation barrier", () => {
  test("invalidate during a held eligibility lookup discards the preparation", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const held = gate();
    const fake = fakeSession({ gates: [held] });
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({ result: { summary: "native summary" } });

    const firing = fake.fire(event);
    registration.invalidate();
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("invalidate during a held history read discards the preparation", async () => {
    const base = await seeded(["keep me"]);
    const captured = await base.get(SESSION);
    const held = gate();
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history: gatedHistory(base, [held]),
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({ result: { summary: "native summary" } });

    const firing = fake.fire(event);
    await tick();
    registration.invalidate();
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await base.get(SESSION)).toHaveLength(1);
  });

  test("dispose during a held eligibility lookup discards the preparation", async () => {
    const history = await seeded(["keep me"]);
    const captured = await history.get(SESSION);
    const held = gate();
    const fake = fakeSession({ gates: [held] });
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const event = compactionEvent({ result: { summary: "native summary" } });

    const firing = fake.fire(event);
    await registration.dispose();
    held.release();
    await firing;

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });

    registration.ended(SESSION, formatCompactionReviews(captured));
    await tick();

    expect(registration.absorbed(SESSION).size).toBe(0);
    expect(await history.get(SESSION)).toHaveLength(1);
  });

  test("invalidate is synchronous, idempotent, and leaves unregistration to dispose", async () => {
    const history = await seeded(["keep me"]);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });

    registration.invalidate();
    registration.invalidate();
    expect(fake.disposals()).toBe(0);

    await registration.dispose();
    await registration.dispose();
    expect(fake.disposals()).toBe(1);
  });

  test("a hook invoked after invalidate is inert", async () => {
    const history = await seeded(["keep me"]);
    const fake = fakeSession();
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    registration.invalidate();

    const event = compactionEvent({ result: { summary: "native summary" } });
    await fake.fire(event);

    expect(event.system).toHaveLength(0);
    expect(event.result).toEqual({ summary: "native summary" });
  });

  test("failed invalidates only its own session's pending preparation", async () => {
    const history = createAdviceHistory(memoryStorage());
    await seedRecord(history, SESSION, "first review");
    await seedRecord(history, "ses_2" as SessionID, "other review");
    const held = gate();
    const fake = fakeSession({ gates: [held] });
    const registration = await registerAdviceCompaction(fake.session as never, {
      history,
      eligibility: fake.eligibility,
    });
    const stale = compactionEvent();
    const staleFiring = fake.fire(stale);
    registration.failed(SESSION);
    const fresh = compactionEvent({ sessionID: "ses_2" });
    await fake.fire(fresh);
    held.release();
    await staleFiring;

    expect(stale.system).toHaveLength(0);
    expect(fresh.system).toHaveLength(1);
    expect(fresh.system[0]?.text).toContain("other review");
  });
});
