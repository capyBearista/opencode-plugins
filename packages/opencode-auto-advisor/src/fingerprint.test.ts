import { describe, expect, test } from "bun:test";
import { routingFingerprint } from "./fingerprint.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";

const user = (text: string): SerializedEntry => ({ role: "user", text });

const assistant = (inFlight: boolean, blocks: readonly AssistantBlock[]): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks,
});

const text = (value: string): AssistantBlock => ({ type: "text", text: value });

const advisorCall: AssistantBlock = {
  type: "tool-call",
  id: "call_advisor",
  name: "advisor",
  status: "running",
  input: {},
};

const readCall: AssistantBlock = {
  type: "tool-call",
  id: "call_read",
  name: "read",
  status: "completed",
  input: { path: "src/a.ts" },
};

const readResult = (value: string): AssistantBlock => ({
  type: "tool-result",
  id: "call_read",
  name: "read",
  text: value,
});

describe("routingFingerprint", () => {
  test("is a deterministic sha256 digest of the canonical preimage", () => {
    expect(routingFingerprint([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(routingFingerprint([user("Fix the bug")])).toMatch(/^[0-9a-f]{64}$/);
    expect(routingFingerprint([user("Fix the bug")])).toBe(
      routingFingerprint([user("Fix the bug")]),
    );
  });

  test("excludes inFlight flags and the in-flight advisor tool-call block", () => {
    const inFlight = [user("Fix the bug"), assistant(true, [text("thinking"), advisorCall])];
    const settled = [user("Fix the bug"), assistant(false, [text("thinking")])];

    expect(routingFingerprint(inFlight)).toBe(routingFingerprint(settled));
  });

  test("keeps non-advisor blocks of an in-flight assistant message", () => {
    const inFlight = [user("Fix the bug"), assistant(true, [readCall, readResult("body")])];
    const settled = [user("Fix the bug"), assistant(false, [readCall, readResult("body")])];
    const withoutBlocks = [user("Fix the bug")];

    expect(routingFingerprint(inFlight)).toBe(routingFingerprint(settled));
    expect(routingFingerprint(inFlight)).not.toBe(routingFingerprint(withoutBlocks));
  });

  test("ignores idle markers and keeps model-switched markers", () => {
    const base = [user("Fix the bug")];
    const idle: SerializedEntry = { role: "marker", type: "idle", detail: "succeeded" };
    const switched: SerializedEntry = { role: "marker", type: "model-switched", detail: "a -> b" };

    expect(routingFingerprint([...base, idle])).toBe(routingFingerprint(base));
    expect(routingFingerprint([...base, switched])).not.toBe(routingFingerprint(base));
  });

  test("changes when a tool result materially changes", () => {
    const before = [user("Fix the bug"), assistant(false, [readCall, readResult("old body")])];
    const after = [user("Fix the bug"), assistant(false, [readCall, readResult("new body")])];

    expect(routingFingerprint(before)).not.toBe(routingFingerprint(after));
  });
});
