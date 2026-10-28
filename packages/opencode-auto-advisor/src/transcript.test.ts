import { describe, expect, test } from "bun:test";
import {
  advisorTranscript,
  DECISION_INPUT_MAX_CHARS,
  decisionInput,
  type Message,
  OMISSION_MARKER,
  renderMessage,
  turnKey,
} from "./transcript.js";

const user = (id: string, text: string): Message => ({
  role: "user",
  id,
  content: [{ type: "text", text }],
});
const call = (id: string, name: string, input: unknown): Message => ({
  role: "assistant",
  id,
  content: [{ type: "tool-call", id: `c-${id}`, name, input }],
});
const result = (name: string, value: unknown, error = false): Message => ({
  role: "tool",
  content: [
    { type: "tool-result", id: "x", name, result: { type: error ? "error" : "text", value } },
  ],
});

// Shapes captured from a real 2.2.0 `context` hook in the spike.
const turn: Message[] = [
  user("u1", "Fix the failing login test"),
  call("a1", "bash", { command: "bun test" }),
  result("bash", "1 fail: AssertionError token expired", true),
  call("a2", "edit", { file: "auth.ts" }),
  result("bash", "ok"),
  { role: "system", id: "s1", content: [{ type: "text", text: "<context>entry</context>" }] },
];

describe("renderMessage", () => {
  test("renders text, tool calls, results, media and drops reasoning", () => {
    const lines = renderMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "secret thoughts" },
        { type: "text", text: "Running tests" },
        { type: "tool-call", id: "1", name: "bash", input: { command: "ls" } },
        { type: "media", filename: "shot.png" },
      ],
    });
    expect(lines).toEqual([
      "ASSISTANT: Running tests",
      'TOOL CALL bash: {"command":"ls"}',
      "[media attachment shot.png: contents not inspected]",
    ]);
  });

  test("marks tool errors and system updates", () => {
    expect(renderMessage(turn[2])).toEqual([
      "TOOL RESULT bash (error): 1 fail: AssertionError token expired",
    ]);
    expect(renderMessage(turn[5])).toEqual(["SYSTEM UPDATE: <context>entry</context>"]);
  });
});

describe("decisionInput", () => {
  test("summarizes only the current turn with counts", () => {
    const text = decisionInput([user("u0", "old request"), result("bash", "old"), ...turn]);
    expect(text).toContain("Latest user request:\nUSER: Fix the failing login test");
    expect(text).not.toContain("old request");
    expect(text).toContain("Steps this turn: 2. Tool errors this turn: 1.");
    expect(text).toContain("TOOL RESULT bash (error)");
  });

  test("prefers the latest real prompt over a synthetic user message", () => {
    const text = decisionInput([...turn, user("skill-1", "skill output")], new Set(["u1"]));
    expect(text).toContain("Latest user request:\nUSER: Fix the failing login test");
    expect(text).toContain("USER: skill output");
  });

  test("stays under the provider input cap", () => {
    const big = Array.from({ length: 200 }, (_, i) => result("read", "x".repeat(5_000 + i)));
    const text = decisionInput([user("u1", "y".repeat(50_000)), ...big]);
    expect(text.length).toBeLessThanOrEqual(DECISION_INPUT_MAX_CHARS + 40);
  });
});

describe("turnKey", () => {
  test("is the id of the latest user prompt, ignoring tool and system messages", () => {
    expect(turnKey(turn)).toBe("u1");
    expect(turnKey([...turn, user("u2", "next")])).toBe("u2");
    expect(turnKey([])).toBeUndefined();
  });
});

describe("advisorTranscript", () => {
  const base = { system: [{ text: "Be careful." }], tools: ["bash", "edit"] };

  test("includes system text, tools and every message when it fits", () => {
    const text = advisorTranscript({ ...base, messages: turn, budgetChars: 10_000 });
    expect(text).toStartWith("SYSTEM PROMPT:\nBe careful.\n\nAVAILABLE TOOLS: bash, edit");
    expect(text).toContain("USER: Fix the failing login test");
    expect(text).not.toContain(OMISSION_MARKER);
  });

  test("over budget keeps the first request and the newest messages", () => {
    const messages = [
      user("u1", "original task"),
      ...Array.from({ length: 50 }, (_, i) => result("read", `chunk-${i} ${"z".repeat(200)}`)),
    ];
    const text = advisorTranscript({ ...base, messages, budgetChars: 2_000 });
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toContain("USER: original task");
    expect(text).toContain(OMISSION_MARKER);
    expect(text).toContain("chunk-49");
    expect(text).not.toContain("chunk-0 ");
  });
});
