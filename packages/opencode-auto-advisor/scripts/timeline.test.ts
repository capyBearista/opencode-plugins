import { describe, expect, test } from "bun:test";
import { renderTimeline, timelineRows } from "./timeline.js";

const at = (n: number) => ({ created: 1_793_000_000_000 + n * 1_000 });
const messages = [
  { id: "u1", type: "user", text: "The big plan", time: at(0) },
  {
    id: "a1",
    type: "assistant",
    content: [
      { type: "text", text: "Reading files" },
      { type: "tool", name: "read", state: { status: "completed", input: { file: "x" } } },
    ],
    time: at(1),
  },
  { id: "u2", type: "user", text: "A small fix", time: at(2) },
  {
    id: "a2",
    type: "assistant",
    content: [{ type: "text", text: "Done <b>now</b>" }],
    time: at(3),
  },
  { id: "y1", type: "system", text: "[auto-advisor review r1] Check the tests.", time: at(4) },
  { id: "a3", type: "assistant", content: [{ type: "text", text: "Next" }], time: at(5) },
];
const record = (step: number, message: string | undefined, extra: object = {}) => ({
  ts: new Date(1_793_000_000_000 + step * 1_000).toISOString(),
  session: "s",
  turn: "u2",
  step,
  mode: "active",
  attempts: [],
  verdict: "routine",
  delivered: false,
  ...(message ? { message, input: `input ${step}` } : {}),
  ...extra,
});

describe("timelineRows", () => {
  test("each step gets the messages since the previous step, in session order", () => {
    const rows = timelineRows(
      "s",
      [record(2, "a2"), record(1, "a1"), { ...record(3, "a3"), session: "other" }],
      messages,
    );
    expect(rows.map((row) => row.record.step)).toEqual([1, 2]);
    expect(rows[0].messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(rows[1].messages.map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  test("a step whose message is unknown, or from before the field existed, has none", () => {
    const rows = timelineRows("s", [record(1, undefined), record(2, "gone")], messages);
    expect(rows.map((row) => row.messages)).toEqual([[], []]);
  });
});

describe("renderTimeline", () => {
  test("renders verdicts, Advisor outcome, input and escaped messages", () => {
    const rows = timelineRows(
      "s",
      [
        record(1, "a1", {
          verdict: "consult",
          moment: { approach: 0.8, routine: 0.2 },
          consequence: 2.5,
          advisor: { model: "mock/exec", ms: 1200, outcome: "ok" },
          delivered: true,
        }),
        record(2, "a2", { verdict: "blocked", blocked: "cooldown" }),
      ],
      messages,
    );
    const html = renderTimeline("s", rows);
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("consult");
    expect(html).toContain("cooldown");
    expect(html).toContain("mock/exec");
    expect(html).toContain("approach 0.80");
    expect(html).toContain("input 1");
    expect(html).toContain("The big plan");
    expect(html).toContain("Done &lt;b&gt;now&lt;/b&gt;");
    expect(html).not.toContain("<b>now</b>");
  });

  test("escapes the logged input and renders lines from before it was logged", () => {
    const rows = timelineRows(
      "s",
      [record(1, undefined), { ...record(2, "a1"), input: "</pre><script>x()</script>" }],
      messages,
    );
    const html = renderTimeline("s", rows);
    expect(html).toContain("(not logged)");
    expect(html).toContain("&lt;/pre&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
