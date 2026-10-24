import { describe, expect, test } from "bun:test";
import {
  appendReminders,
  applyStyle,
  FALLBACK_REMINDER,
  reminderText,
  stripCodingSections,
} from "./prompt.js";
import type { Style } from "./styles.js";

const DEFAULT_PROMPT = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- Prefer parallelizing independent tool calls.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.`;

const ANTHROPIC_APPEND = `# Code comments
By default, match the surrounding comment density: where the code has none, add none.`;

const style = (overrides: Partial<Style> = {}): Style => ({
  id: "x",
  name: "X",
  description: "",
  prompt: "STYLE PROMPT",
  keepCodingInstructions: true,
  source: "global",
  ...overrides,
});

describe("reminderText", () => {
  test("uses the turn reminder", () => {
    expect(reminderText({ name: "Concise", turnReminder: "Be brief." })).toBe(
      "<system-reminder>\nConcise output style is active. Be brief.\n</system-reminder>",
    );
  });

  test("falls back without a turn reminder", () => {
    expect(reminderText({ name: "Learning" })).toBe(
      `<system-reminder>\nLearning output style is active. ${FALLBACK_REMINDER}\n</system-reminder>`,
    );
  });
});

describe("stripCodingSections", () => {
  test("removes the codebase section and keeps the others", () => {
    const out = stripCodingSections(DEFAULT_PROMPT);
    expect(out).not.toContain("Working in codebases");
    expect(out).not.toContain("Keep changes consistent");
    expect(out).toContain("# Harness");
    expect(out).toContain("# Communication");
    expect(out.endsWith("technical jargon.")).toBe(true);
  });

  test("removes both sections from default + anthropic append", () => {
    const out = stripCodingSections(`${DEFAULT_PROMPT}\n\n${ANTHROPIC_APPEND}`);
    expect(out).not.toContain("Working in codebases");
    expect(out).not.toContain("Code comments");
    expect(out).not.toContain("comment density");
    expect(out).toContain("# Communication");
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("returns text without the headings unchanged", () => {
    const text = "# Harness\nstuff\n\n\n\n## Working in codebases\nnested heading stays\n";
    expect(stripCodingSections(text)).toBe(text);
  });

  test("stops at the next top-level heading", () => {
    const text = "# A\na\n\n# Code comments\nc1\n## inner\nc2\n\n# B\nb\n\n## B.1\nsub";
    expect(stripCodingSections(text)).toBe("# A\na\n\n# B\nb\n\n## B.1\nsub");
  });

  test("heading must match exactly", () => {
    const text = "# Working in codebases today\nkeep\n";
    expect(stripCodingSections(text)).toBe(text);
  });
});

describe("applyStyle", () => {
  const base = () => [{ type: "text", text: DEFAULT_PROMPT }];

  test("pushes the style prompt and keeps coding sections by default", () => {
    const system = base();
    applyStyle(system, style(), false);
    expect(system).toEqual([
      { type: "text", text: DEFAULT_PROMPT },
      { type: "text", text: "STYLE PROMPT" },
    ]);
  });

  test("strips system[0] when coding instructions are dropped", () => {
    const system = [{ type: "text", text: DEFAULT_PROMPT, cache: true }];
    applyStyle(system, style({ keepCodingInstructions: false }), false);
    expect(system[0]?.text).not.toContain("Working in codebases");
    expect(system[0]).toHaveProperty("cache", true);
    expect(system[1]?.text).toBe("STYLE PROMPT");
  });

  test("leaves system[0] alone when the agent has its own system prompt", () => {
    const system = base();
    applyStyle(system, style({ keepCodingInstructions: false }), true);
    expect(system[0]?.text).toBe(DEFAULT_PROMPT);
    expect(system).toHaveLength(2);
  });

  test("just pushes when there is no system[0]", () => {
    const system: Array<{ type: string; text: string }> = [];
    applyStyle(system, style({ keepCodingInstructions: false }), false);
    expect(system).toEqual([{ type: "text", text: "STYLE PROMPT" }]);
  });
});

describe("appendReminders", () => {
  const text = "<system-reminder>r</system-reminder>";
  const make = () => [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "tool", content: [{ type: "tool-result", id: "1" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ];

  test("appends a text part to every user message and returns the count", () => {
    const messages = make();
    expect(appendReminders(messages, text)).toBe(2);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text },
    ]);
    expect(messages[3]?.content).toEqual([
      { type: "text", text: "again" },
      { type: "text", text },
    ]);
  });

  test("leaves assistant and tool messages untouched", () => {
    const messages = make();
    appendReminders(messages, text);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "hi" }]);
    expect(messages[2]?.content).toEqual([{ type: "tool-result", id: "1" }]);
  });

  test("is idempotent", () => {
    const messages = make();
    appendReminders(messages, text);
    expect(appendReminders(messages, text)).toBe(0);
    expect(messages[0]?.content).toHaveLength(2);
  });

  test("ignores string content", () => {
    const messages = [{ role: "user", content: "plain" }];
    expect(appendReminders(messages, text)).toBe(0);
    expect(messages[0]?.content).toBe("plain");
  });
});
