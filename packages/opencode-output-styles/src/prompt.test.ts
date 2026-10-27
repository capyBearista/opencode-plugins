import { describe, expect, test } from "bun:test";
import { appendReminders, entryValue, FALLBACK_REMINDER, reminderText } from "./prompt.js";

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

describe("entryValue", () => {
  test("names the style above its prompt", () => {
    expect(entryValue({ name: "Concise", prompt: "Be brief." })).toBe(
      "Concise output style\n\nBe brief.",
    );
  });
});

describe("appendReminders", () => {
  const make = () => [
    { role: "user", id: "u1", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", id: "a1", content: [{ type: "text", text: "hi" }] },
    { role: "tool", id: "t1", content: [{ type: "tool-result", id: "1" }] },
    { role: "user", id: "u2", content: [{ type: "text", text: "later" }] },
    { role: "user", id: "syn", content: [{ type: "text", text: "harness" }] },
    { role: "user", content: [{ type: "text", text: "no id" }] },
  ];
  const recorded: Record<string, string> = { u1: "<r>one</r>", u2: "<r>two</r>", a1: "<r>x</r>" };
  const reminderOf = (id: string) => recorded[id];

  test("appends each prompt's own recorded reminder and returns the count", () => {
    const messages = make();
    expect(appendReminders(messages, reminderOf)).toBe(2);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "<r>one</r>" },
    ]);
    expect(messages[3]?.content).toEqual([
      { type: "text", text: "later" },
      { type: "text", text: "<r>two</r>" },
    ]);
  });

  test("leaves messages without a recorded reminder untouched", () => {
    const messages = make();
    appendReminders(messages, reminderOf);
    expect(messages[4]?.content).toEqual([{ type: "text", text: "harness" }]);
    expect(messages[5]?.content).toEqual([{ type: "text", text: "no id" }]);
  });

  test("leaves assistant and tool messages untouched even if a reminder is recorded", () => {
    const messages = make();
    appendReminders(messages, () => "<r>any</r>");
    expect(messages[1]?.content).toEqual([{ type: "text", text: "hi" }]);
    expect(messages[2]?.content).toEqual([{ type: "tool-result", id: "1" }]);
  });

  test("is idempotent", () => {
    const messages = make();
    appendReminders(messages, reminderOf);
    expect(appendReminders(messages, reminderOf)).toBe(0);
    expect(messages[0]?.content).toHaveLength(2);
  });

  test("ignores string content", () => {
    const messages = [{ role: "user", id: "u1", content: "plain" }];
    expect(appendReminders(messages, reminderOf)).toBe(0);
    expect(messages[0]?.content).toBe("plain");
  });
});
