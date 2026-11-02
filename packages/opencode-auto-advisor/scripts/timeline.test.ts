import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMessages, renderTimeline, timelineRows } from "./timeline.js";

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

/** An explicit `advisor()` call's line: no step, verdict or Decision input. */
const explicit = (at: number, message: string, advisor: object = {}) => ({
  ts: new Date(1_793_000_000_000 + at * 1_000).toISOString(),
  session: "s",
  message,
  kind: "explicit",
  advisor: { model: "mock/deep", ms: 4_200, outcome: "ok", attempts: [], ...advisor },
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

  test("an advisor() call takes no messages from the routing steps around it", () => {
    const rows = timelineRows(
      "s",
      [record(1, "a1"), explicit(1.5, "a2"), record(2, "a2")],
      messages,
    );
    expect(rows.map((row) => row.messages.map((m) => m.id))).toEqual([
      ["u1", "a1"],
      [],
      ["u2", "a2"],
    ]);
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

  test("renders advisor() calls as their own rows next to routing steps", () => {
    const rows = timelineRows(
      "s",
      [
        record(1, "a1"),
        explicit(1.5, "a2", { model: "mock/<deep>", ms: 1_000, outcome: "error", error: "down" }),
        explicit(1.7, "a2"),
        record(2, "a2"),
      ],
      messages,
    );
    const html = renderTimeline("s", rows);
    expect(html).toContain("2 routing decisions and 2 advisor() calls");
    expect(html).toContain("advisor() call");
    expect(html).toContain("mock/&lt;deep&gt;");
    expect(html).toContain("error · 1.0 s · down");
    expect(html).toContain("mock/deep · ok · 4.2 s");
    expect(html).not.toContain("undefined");
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

describe("fetchMessages", () => {
  // OpenCode's CLI exits right after writing, so a large page read through a pipe arrives cut
  // short. Each page here is about 3 MB.
  test("reads every page whole, even when the CLI exits right after writing", () => {
    const fake = [process.execPath, `${import.meta.dir}/fixtures/fake-opencode.ts`];
    for (let run = 0; run < 5; run++) {
      const messages = fetchMessages("s", fake);
      expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
      expect(messages.every((m) => m.text?.length === 1_000_003)).toBe(true);
    }
    // Five rounds of 3 MB pages through real subprocesses: well over 5 s on a slow CI runner.
  }, 30_000);
});

describe("bun run timeline", () => {
  // The page holds the user's requests and the Decision input, like telemetry (0600).
  test("writes a page only its owner can read, also over an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "timeline-test-"));
    const shim = join(dir, "opencode");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${import.meta.dir}/fixtures/fake-opencode.ts" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const page = join(dir, "page.html");
    writeFileSync(page, "old");
    chmodSync(page, 0o644);
    const result = Bun.spawnSync(
      [process.execPath, `${import.meta.dir}/timeline.ts`, "s", "--out", page],
      { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_DATA_HOME: dir } },
    );
    try {
      expect(result.exitCode).toBe(0);
      expect(statSync(page).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
