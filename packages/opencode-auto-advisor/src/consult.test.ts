import { describe, expect, test } from "bun:test";
import { buildAdvisorProjection } from "./advisor-projection.js";
import { mergeExplicitConsult } from "./consult.js";
import type { CapturedHistory } from "./context.js";
import { turnKeyForHistory } from "./request.js";
import { type SerializedEntry, serializeAdvisorContext } from "./serialize.js";
import type { RequestSnapshot } from "./snapshot-store.js";

const system = (text: string): SerializedEntry => ({ role: "system", text });
const user = (text: string): SerializedEntry => ({ role: "user", text });
const assistant = (inFlight: boolean): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks: [
    { type: "reasoning", text: "HOOK-MUTATION-REASONING" },
    { type: "text", text: "HOOK-MUTATION-ASSISTANT" },
    { type: "tool-call", id: "call_advisor", name: "advisor", status: "running", input: {} },
  ],
});

const assistantWith = (text: string, inFlight: boolean): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks: [{ type: "text", text }],
});

function history(overrides: Partial<CapturedHistory> = {}): CapturedHistory {
  const entries = [user("HOOK-MUTATION-USER"), assistant(true)];
  return {
    entries,
    messageIDs: ["msg-user", "msg-current"],
    transcript: JSON.stringify(entries),
    lastUserMessageID: "msg-user",
    executorModel: { providerID: "opencode", id: "jev-1.13" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    sessionID: "ses_1" as RequestSnapshot["sessionID"],
    turnKey: "msg-user",
    entries: [system("HOOK-ONLY-SYSTEM"), user("HOOK-MUTATION-USER")],
    executorModel: { providerID: "opencode", id: "jev-1.13" },
    ...overrides,
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("mergeExplicitConsult", () => {
  test("combines the captured request with only the current-turn delta exactly once", () => {
    const merged = mergeExplicitConsult({
      snapshot: snapshot(),
      history: history(),
      messageID: "msg-current",
    });

    expect(merged.entries).toEqual([
      system("HOOK-ONLY-SYSTEM"),
      user("HOOK-MUTATION-USER"),
      assistant(true),
    ]);
    const transcript = serializeAdvisorContext(merged.entries);
    expect(occurrences(transcript, "HOOK-ONLY-SYSTEM")).toBe(1);
    expect(occurrences(transcript, "HOOK-MUTATION-USER")).toBe(1);
    expect(occurrences(transcript, "HOOK-MUTATION-ASSISTANT")).toBe(1);
    expect(occurrences(transcript, "HOOK-MUTATION-REASONING")).toBe(1);
    expect(buildAdvisorProjection(merged.entries).transcript).not.toContain(
      "HOOK-MUTATION-REASONING",
    );
    expect(occurrences(transcript, "call_advisor")).toBe(1);
    expect(transcript).toContain('"inFlight":true');
  });

  test("returns canonical entries without a prebuilt unbounded transcript", () => {
    const merged = mergeExplicitConsult({
      snapshot: snapshot(),
      history: history(),
      messageID: "msg-current",
    });

    expect(Object.keys(merged).sort()).toEqual(["entries", "executorModel"]);
  });

  test("keeps earlier turns from the snapshot exactly once across multi-turn history", () => {
    const currentAssistant = assistantWith("CURRENT-ASSISTANT-DELTA", true);
    const snapshotEntries = [
      system("HOOK-ONLY-SYSTEM"),
      user("SNAPSHOT-USER-ONE"),
      assistantWith("SNAPSHOT-ASSISTANT-ONE", false),
      user("SNAPSHOT-USER-TWO"),
    ];
    const merged = mergeExplicitConsult({
      snapshot: snapshot({ turnKey: "msg-user-2", entries: snapshotEntries }),
      history: history({
        entries: [
          user("DURABLE-USER-ONE"),
          assistantWith("DURABLE-ASSISTANT-ONE", false),
          user("DURABLE-USER-TWO"),
          currentAssistant,
        ],
        messageIDs: ["msg-user-1", "msg-assistant-1", "msg-user-2", "msg-current"],
        lastUserMessageID: "msg-user-2",
      }),
      messageID: "msg-current",
    });

    expect(merged.entries).toEqual([...snapshotEntries, currentAssistant]);
    const transcript = serializeAdvisorContext(merged.entries);
    for (const marker of [
      "HOOK-ONLY-SYSTEM",
      "SNAPSHOT-USER-ONE",
      "SNAPSHOT-ASSISTANT-ONE",
      "SNAPSHOT-USER-TWO",
      "CURRENT-ASSISTANT-DELTA",
    ]) {
      expect(occurrences(transcript, marker)).toBe(1);
    }
    for (const marker of ["DURABLE-USER-ONE", "DURABLE-ASSISTANT-ONE", "DURABLE-USER-TWO"]) {
      expect(transcript).not.toContain(marker);
    }
  });

  test("never attaches a snapshot from a different turn", () => {
    const merged = mergeExplicitConsult({
      snapshot: snapshot({ turnKey: "msg-user-old" }),
      history: history({ executorModel: undefined }),
      messageID: "msg-current",
    });

    expect(merged.entries).toEqual(history().entries);
    expect(serializeAdvisorContext(merged.entries)).not.toContain("HOOK-ONLY-SYSTEM");
    expect(merged.executorModel).toBeUndefined();
  });

  test("falls back to durable history without a snapshot or current message", () => {
    const withoutSnapshot = mergeExplicitConsult({
      history: history(),
      messageID: "msg-current",
    });
    const withoutMessage = mergeExplicitConsult({
      snapshot: snapshot(),
      history: history(),
      messageID: "msg-unknown",
    });

    expect(withoutSnapshot.entries).toEqual(history().entries);
    expect(withoutMessage.entries).toEqual(history().entries);
  });

  test("merges hook-time content for an id-less turn keyed by content identity", () => {
    const currentAssistant = assistantWith("CURRENT-ASSISTANT-DELTA", true);
    const durable = history({
      entries: [user("IDLESS-USER"), currentAssistant],
      messageIDs: ["", "msg-current"],
      lastUserMessageID: undefined,
    });
    const merged = mergeExplicitConsult({
      snapshot: snapshot({
        turnKey: turnKeyForHistory(durable),
        entries: [system("HOOK-ONLY-SYSTEM"), user("IDLESS-USER")],
      }),
      history: durable,
      messageID: "msg-current",
    });

    expect(merged.entries).toEqual([
      system("HOOK-ONLY-SYSTEM"),
      user("IDLESS-USER"),
      currentAssistant,
    ]);
    expect(serializeAdvisorContext(merged.entries)).toContain("HOOK-ONLY-SYSTEM");
  });

  test("never attaches an id-less snapshot from a different content turn", () => {
    const durable = history({
      entries: [user("IDLESS-USER"), assistantWith("CURRENT-ASSISTANT-DELTA", true)],
      messageIDs: ["", "msg-current"],
      lastUserMessageID: undefined,
    });
    const merged = mergeExplicitConsult({
      snapshot: snapshot({
        turnKey: "content:0:stale",
        entries: [system("HOOK-ONLY-SYSTEM")],
      }),
      history: durable,
      messageID: "msg-current",
    });

    expect(merged.entries).toEqual(durable.entries);
    expect(serializeAdvisorContext(merged.entries)).not.toContain("HOOK-ONLY-SYSTEM");
  });

  test("keys no-user turns by their full content identity", () => {
    const durable = history({
      entries: [assistantWith("CURRENT-ASSISTANT-DELTA", true)],
      messageIDs: ["msg-current"],
      lastUserMessageID: undefined,
    });
    const key = turnKeyForHistory(durable);
    const merged = mergeExplicitConsult({
      snapshot: snapshot({ turnKey: key, entries: [system("HOOK-ONLY-SYSTEM")] }),
      history: durable,
      messageID: "msg-current",
    });
    const stale = mergeExplicitConsult({
      snapshot: snapshot({
        turnKey: "content:no-user:stale",
        entries: [system("HOOK-ONLY-SYSTEM")],
      }),
      history: durable,
      messageID: "msg-current",
    });

    expect(key.startsWith("content:no-user:")).toBe(true);
    expect(serializeAdvisorContext(merged.entries)).toContain("HOOK-ONLY-SYSTEM");
    expect(serializeAdvisorContext(stale.entries)).not.toContain("HOOK-ONLY-SYSTEM");
  });

  test("prefers the current executor model and falls back to the snapshot model", () => {
    const current = mergeExplicitConsult({
      snapshot: snapshot({ executorModel: { providerID: "opencode", id: "stale" } }),
      history: history(),
      messageID: "msg-current",
    });
    const fromSnapshot = mergeExplicitConsult({
      snapshot: snapshot(),
      history: history({ executorModel: undefined }),
      messageID: "msg-current",
    });

    expect(current.executorModel).toEqual({ providerID: "opencode", id: "jev-1.13" });
    expect(fromSnapshot.executorModel).toEqual({ providerID: "opencode", id: "jev-1.13" });
  });
});
