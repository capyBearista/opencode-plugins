import { describe, expect, test } from "bun:test";
import type { SessionID } from "./messages.js";
import type { SerializedEntry } from "./serialize.js";
import { createSnapshotStore, type RequestSnapshot } from "./snapshot-store.js";

const entry = (text: string): SerializedEntry => ({ role: "user", text });

function snapshot(sessionID: string, turnKey: string, text: string): RequestSnapshot {
  return {
    sessionID: sessionID as SessionID,
    turnKey,
    entries: [entry(text)],
    executorModel: { providerID: "opencode", id: "jev-1.13" },
  };
}

describe("createSnapshotStore", () => {
  test("reads a snapshot only while its turn key is current", () => {
    const store = createSnapshotStore();
    store.capture(snapshot("ses_1", "msg-user-a", "first turn"));

    expect(store.read("ses_1" as SessionID, "msg-user-a")?.entries).toEqual([entry("first turn")]);
    expect(store.read("ses_1" as SessionID, "msg-user-b")).toBeUndefined();
    expect(store.read("ses_2" as SessionID, "msg-user-a")).toBeUndefined();
  });

  test("replaces the previous snapshot for a session and never serves stale turns", () => {
    const store = createSnapshotStore();
    store.capture(snapshot("ses_1", "msg-user-a", "first turn"));
    store.capture(snapshot("ses_1", "msg-user-b", "second turn"));

    expect(store.sessions()).toBe(1);
    expect(store.read("ses_1" as SessionID, "msg-user-a")).toBeUndefined();
    expect(store.read("ses_1" as SessionID, "msg-user-b")?.entries).toEqual([entry("second turn")]);
  });

  test("bounds the store and evicts the least recently used session", () => {
    const store = createSnapshotStore({ maxSessions: 2 });
    store.capture(snapshot("ses_1", "turn-1", "one"));
    store.capture(snapshot("ses_2", "turn-2", "two"));
    expect(store.read("ses_1" as SessionID, "turn-1")?.turnKey).toBe("turn-1");

    store.capture(snapshot("ses_3", "turn-3", "three"));

    expect(store.sessions()).toBe(2);
    expect(store.read("ses_2" as SessionID, "turn-2")).toBeUndefined();
    expect(store.read("ses_1" as SessionID, "turn-1")?.turnKey).toBe("turn-1");
    expect(store.read("ses_3" as SessionID, "turn-3")?.turnKey).toBe("turn-3");
  });

  test("recaptures do not grow the store for the same session", () => {
    const store = createSnapshotStore({ maxSessions: 2 });
    for (let index = 0; index < 10; index += 1) {
      store.capture(snapshot("ses_1", `turn-${index}`, `turn ${index}`));
    }
    expect(store.sessions()).toBe(1);
  });
});
