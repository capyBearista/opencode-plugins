import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DESCRIPTION } from "./advisor.js";
import fixtures from "./fixtures/s1-decisions.json";
import server from "./server.js";
import { COMPACTED, OMISSION_MARKER } from "./transcript.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed fake host context
type Any = any;

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "auto-advisor-server-"));
  for (const name of ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"]) saved[name] = process.env[name];
  process.env.OPENCODE_CONFIG_DIR = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  await mkdir(join(root, "config"), { recursive: true });
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const writeConfig = (config: unknown) =>
  writeFile(join(root, "config", "auto-advisor.json"), JSON.stringify(config));

const STUCK = fixtures.ok;
const ROUTINE = {
  answers: [
    {
      name: "moment",
      type: "choice",
      choice: "routine",
      probabilities: [
        { value: "approach", probability: 0.05 },
        { value: "stuck", probability: 0.05 },
        { value: "done", probability: 0 },
        { value: "routine", probability: 0.9 },
      ],
    },
    { name: "consequence", type: "score", score: 0.4 },
  ],
};

interface Setup {
  decision?: () => Promise<Any>;
  advice?: (input: Any) => Promise<{ text: string }>;
  parent?: string;
  /** The session's stored history, as `ctx.session.context` returns it. */
  stored?: Any[];
}

async function start(setup: Setup = {}) {
  const decisionCalls: Any[] = [];
  const textCalls: Any[] = [];
  const entries: Record<string, Any> = {};
  const emitted: string[] = [];
  const hooks: Record<string, Any> = {};
  let tool: Any;
  let rpc: Any;
  const queue: Any[] = [];
  let wake: (() => void) | undefined;

  const ctx: Any = {
    experimental: {
      generate: {
        decisions: async (request: Any) => {
          decisionCalls.push(request);
          return setup.decision ? setup.decision() : STUCK;
        },
        text: async (input: Any) => {
          textCalls.push(input);
          return setup.advice ? setup.advice(input) : { text: "Check the token clock skew first." };
        },
      },
    },
    model: {
      list: async () => ({
        data: [
          { providerID: "mock", id: "exec", limit: { context: 50_000 } },
          { providerID: "mock", id: "small", limit: { context: 1_000 } },
        ],
      }),
    },
    session: {
      get: async ({ sessionID }: Any) => ({
        id: sessionID,
        parentID: sessionID === "child" ? "root" : undefined,
      }),
      context: async () => [
        ...(setup.stored ?? [{ id: "u1", type: "user" }]),
        {
          id: "a-live",
          type: "assistant",
          content: [{ type: "tool", name: "advisor", state: { input: {} } }],
        },
      ],
      hook: async (name: string, fn: Any) => {
        hooks[name] = fn;
        return { dispose: async () => {} };
      },
      instructions: {
        entry: {
          list: async ({ sessionID }: Any) =>
            entries[sessionID] ? [{ key: "auto-advisor", value: entries[sessionID] }] : [],
          put: async ({ sessionID, value }: Any) => {
            entries[sessionID] = value;
          },
        },
      },
    },
    tool: {
      transform: async (fn: Any) => {
        fn({ add: (definition: Any) => (tool = definition) });
        return { dispose: async () => {} };
      },
    },
    rpc: {
      register: async (_definition: Any, handlers: Any) => {
        rpc = handlers;
        return { dispose: async () => {}, events: { emit: (name: string) => emitted.push(name) } };
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            return { done: false, value: queue.shift() };
          },
          return: async () => ({ done: true, value: undefined }),
        }),
      }),
    },
  };

  const dispose = await server.setup(ctx);
  const send = async (event: Any) => {
    queue.push(event);
    wake?.();
    await Bun.sleep(5);
  };
  return {
    ctx,
    hooks,
    decisionCalls,
    textCalls,
    entries,
    emitted,
    send,
    dispose,
    tool: () => tool,
    rpc: () => rpc,
  };
}

const user = (id: string, text = "Fix the login test") => ({
  role: "user",
  id,
  content: [{ type: "text", text }],
});
const step = (n: number) => [
  {
    role: "assistant",
    id: `a${n}`,
    content: [{ type: "tool-call", id: `c${n}`, name: "bash", input: {} }],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", id: `c${n}`, name: "bash", result: { type: "error", value: "fail" } },
    ],
  },
];

function request(sessionID: string, messages: Any[]) {
  return {
    sessionID,
    model: { providerID: "mock", id: "exec" },
    agent: "build",
    system: [{ type: "text", text: "You are a coding agent." }],
    messages,
    options: {},
    tools: { advisor: {}, bash: {} },
  };
}

const telemetryLines = async () => {
  const text = await readFile(
    join(root, "data", "opencode", "auto-advisor", "telemetry.jsonl"),
    "utf8",
  ).catch(() => "");
  return text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
};

const tail = (event: Any) => event.messages.at(-1);

describe("off", () => {
  test("registers the advisor tool and never calls the Decision model", async () => {
    await writeConfig({ routing: { mode: "off" } });
    const host = await start();
    expect(host.tool().name).toBe("advisor");
    expect(host.tool().description).toBe(TOOL_DESCRIPTION);
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(host.decisionCalls).toHaveLength(0);
    expect(event.messages).toHaveLength(3);
  });
});

describe("active (default)", () => {
  test("an accepted moment delivers the review now and stores it for later steps", async () => {
    const host = await start();
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);

    expect(host.decisionCalls[0].model).toEqual({ providerID: "opencode", id: "jev-1.13-free" });
    expect(host.textCalls[0].model).toEqual({ providerID: "mock", id: "exec" });
    expect(host.textCalls[0].prompt).toContain("judged them to be stuck");
    expect(host.textCalls[0].prompt).toContain("SYSTEM PROMPT:\nYou are a coding agent.");
    expect(tail(event).role).toBe("system");
    expect(tail(event).content[0].text).toContain("Check the token clock skew first.");
    expect(host.entries.s).toBe(tail(event).content[0].text);
    await Bun.sleep(20);
    expect(host.emitted).toEqual(["review.started", "review.finished"]);
    const [line] = await telemetryLines();
    expect(line).toMatchObject({
      mode: "active",
      verdict: "consult",
      delivered: true,
      step: 1,
      turn: "u1",
    });
    expect(JSON.stringify(line)).not.toContain("clock skew");
  });

  test("an inherited Advisor keeps the Executor's variant", async () => {
    const host = await start();
    const event = {
      ...request("s", [user("u1"), ...step(1)]),
      model: { providerID: "mock", id: "exec", variant: "max" },
    };
    await host.hooks.context(event);
    expect(host.textCalls[0].model).toEqual({ providerID: "mock", id: "exec", variant: "max" });
    await Bun.sleep(20);
    expect((await telemetryLines())[0].advisor.model).toBe("mock/exec#max");
  });

  test("a routine moment changes nothing", async () => {
    const host = await start({ decision: async () => ROUTINE });
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(host.textCalls).toHaveLength(0);
    expect(event.messages).toHaveLength(3);
    await Bun.sleep(20);
    expect((await telemetryLines())[0].verdict).toBe("routine");
  });

  test("the per-turn budget caps consults at 2 and resets on the next prompt", async () => {
    await writeConfig({ routing: { minStepsBetweenConsultations: 0 } });
    const host = await start();
    const history: Any[] = [user("u1")];
    for (let n = 1; n <= 3; n++) {
      history.push(...step(n));
      await host.hooks.context(request("s", [...history]));
      await Bun.sleep(10);
    }
    expect(host.textCalls).toHaveLength(2);
    await host.hooks.prompt({ sessionID: "s", messageID: "u2", delivery: "steer" });
    await host.hooks.context(request("s", [...history, user("u2", "next")]));
    expect(host.textCalls).toHaveLength(3);
    const lines = await telemetryLines();
    expect(lines.map((line) => line.blocked)).toEqual([undefined, undefined, "budget", undefined]);
    expect(lines[2].verdict).toBe("blocked");
  });

  test("a step blocked by both limits reports the cooldown; the budget shows after it", async () => {
    await writeConfig({
      routing: { maxConsultationsPerTurn: 1, minStepsBetweenConsultations: 3 },
    });
    const host = await start();
    const history: Any[] = [user("u1")];
    for (let n = 1; n <= 4; n++) {
      history.push(...step(n));
      await host.hooks.context(request("s", [...history]));
      await Bun.sleep(10);
    }
    expect(host.textCalls).toHaveLength(1);
    const lines = await telemetryLines();
    expect(lines.map((line) => line.blocked)).toEqual([
      undefined,
      "cooldown",
      "cooldown",
      "budget",
    ]);
  });

  test("after a restart, a synthetic user message is neither the turn nor the request", async () => {
    // One consult per turn: a second one would mean the synthetic message started a turn.
    await writeConfig({
      routing: { maxConsultationsPerTurn: 1, minStepsBetweenConsultations: 0 },
    });
    // The plugin starts mid-session: no `prompt` hook has fired, the stored history has types.
    const host = await start({
      stored: [
        { id: "u1", type: "user" },
        { id: "syn-1", type: "synthetic" },
      ],
    });
    const history: Any[] = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    history.push(user("syn-1", '<subagent state="completed">done</subagent>'), ...step(2));
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    expect(host.textCalls).toHaveLength(1);
    const input = host.decisionCalls.at(-1).input[0].text;
    expect(input).toContain(
      "User requests (oldest first; the last is the latest):\nUSER: Fix the login test\n\nRecent",
    );
    expect(input).toContain("SUBAGENT: <subagent");
    expect((await telemetryLines()).map((line) => line.turn)).toEqual(["u1", "u1"]);
  });

  test("requests from before a restart and from the prompt hook are both shown", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    const host = await start({ stored: [{ id: "u1", type: "user" }] });
    await host.hooks.prompt({ sessionID: "s", messageID: "u2", delivery: "steer" });
    await host.hooks.context(
      request("s", [user("u1", "The big plan"), ...step(1), user("u2", "A small fix"), ...step(2)]),
    );
    await Bun.sleep(10);
    const input = host.decisionCalls[0].input[0].text;
    expect(input).toContain("USER: The big plan\n\nUSER: A small fix");
    expect((await telemetryLines())[0]).toMatchObject({ turn: "u2", step: 1 });
  });

  test("a prompt admitted but not yet delivered does not start a new turn", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    const host = await start();
    const history: Any[] = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    // Queued: the hook fired, but the message is not in the request yet.
    await host.hooks.prompt({ sessionID: "s", messageID: "u2", delivery: "queue" });
    history.push(...step(2));
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    const input = host.decisionCalls.at(-1).input[0].text;
    expect(input).toContain("USER: Fix the login test");
    expect(input).toContain("Steps this turn: 2.");
    expect((await telemetryLines()).map((line) => [line.turn, line.step])).toEqual([
      ["u1", 1],
      ["u1", 2],
    ]);
  });

  test("a compaction that drops the prompt keeps the turn and its budget", async () => {
    await writeConfig({
      routing: { maxConsultationsPerTurn: 1, minStepsBetweenConsultations: 0 },
    });
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    await Bun.sleep(10);
    // The window now starts at the compaction summary; the prompt is no longer in it.
    const summary = {
      role: "user",
      id: "cmp-1",
      content: [{ type: "compaction", text: "Summary of the work so far." }],
    };
    await host.hooks.context(request("s", [summary, ...step(2)]));
    await Bun.sleep(10);
    expect(host.textCalls).toHaveLength(1);
    const lines = await telemetryLines();
    expect(lines.map((line) => [line.turn, line.step, line.blocked])).toEqual([
      ["u1", 1, undefined],
      ["u1", 2, "budget"],
    ]);
  });

  test("a queued prompt does not reset the budget before it is delivered", async () => {
    await writeConfig({
      routing: { maxConsultationsPerTurn: 1, minStepsBetweenConsultations: 0 },
    });
    const host = await start();
    const history: Any[] = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    await host.hooks.prompt({ sessionID: "s", messageID: "u2", delivery: "queue" });
    history.push(...step(2));
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    expect(host.textCalls).toHaveLength(1);
    expect((await telemetryLines()).at(-1).blocked).toBe("budget");
  });

  test("a failed history read is retried on the next step", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    const host = await start({ stored: [{ id: "u1", type: "user" }] });
    const read = host.ctx.session.context;
    let calls = 0;
    host.ctx.session.context = async (input: Any) => {
      calls++;
      if (calls === 1) throw new Error("busy");
      return read(input);
    };
    const history: Any[] = [user("u1", "The stored plan"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    history.push(...step(2));
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(10);
    expect(host.decisionCalls.at(-1).input[0].text).toContain("USER: The stored plan");
  });

  test("the cooldown counts distinct steps across turns, not retries", async () => {
    await writeConfig({
      routing: { maxConsultationsPerTurn: 100, minStepsBetweenConsultations: 3 },
    });
    const host = await start();
    const history: Any[] = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    for (let n = 2; n <= 3; n++) {
      history.push(...step(n));
      await host.hooks.context(request("s", [...history]));
      await Bun.sleep(10);
      // A retried step is not a new step.
      await host.hooks.context(request("s", [...history]));
      await Bun.sleep(10);
    }
    expect(host.textCalls).toHaveLength(1);
    // A new turn resets the budget but not the cooldown: this is the 4th distinct step.
    await host.hooks.prompt({ sessionID: "s", messageID: "u2", delivery: "steer" });
    await host.hooks.context(request("s", [...history, user("u2", "next")]));
    expect(host.textCalls).toHaveLength(2);
    const lines = await telemetryLines();
    expect(lines.map((line) => line.blocked)).toEqual([
      undefined,
      "cooldown",
      "cooldown",
      undefined,
    ]);
  });

  test("a retried step reuses its review and never adds it twice", async () => {
    const host = await start();
    const messages = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...messages]));
    // Retry with the entry already admitted: nothing new is added or asked.
    const admitted = {
      role: "system",
      id: "m-entry",
      content: [{ type: "text", text: host.entries.s }],
    };
    const retry = request("s", [...messages, admitted]);
    await host.hooks.context(retry);
    expect(retry.messages).toHaveLength(4);
    // Retry before admission: the same review is re-added.
    const bare = request("s", [...messages]);
    await host.hooks.context(bare);
    expect(tail(bare).content[0].text).toBe(host.entries.s);
    expect(host.decisionCalls).toHaveLength(1);
    expect(host.textCalls).toHaveLength(1);
  });

  test("a run interrupted during the consult delivers nothing", async () => {
    let release: (value: { text: string }) => void = () => {};
    const host = await start({ advice: () => new Promise((resolve) => (release = resolve)) });
    const event = request("s", [user("u1"), ...step(1)]);
    const pending = host.hooks.context(event);
    await Bun.sleep(10);
    await host.send({
      type: "session.execution.interrupted",
      data: { sessionID: "s", reason: "user" },
    });
    release({ text: "late advice" });
    await pending;
    expect(event.messages).toHaveLength(3);
    expect(host.entries.s).toBeUndefined();
  });

  test("an interrupt during the Decision call skips the consult", async () => {
    let answer: (value: Any) => void = () => {};
    const host = await start({ decision: () => new Promise((resolve) => (answer = resolve)) });
    const event = request("s", [user("u1"), ...step(1)]);
    const pending = host.hooks.context(event);
    await Bun.sleep(10);
    await host.send({
      type: "session.execution.interrupted",
      data: { sessionID: "s", reason: "user" },
    });
    answer(STUCK);
    await pending;
    expect(host.textCalls).toHaveLength(0);
    expect(host.emitted).toEqual([]);
  });

  test("an interrupt ends a pending consult at once, without marking it failed", async () => {
    const host = await start({ advice: () => new Promise(() => {}) });
    const event = request("s", [user("u1"), ...step(1)]);
    const pending = host.hooks.context(event);
    await Bun.sleep(10);
    await host.send({
      type: "session.execution.interrupted",
      data: { sessionID: "s", reason: "user" },
    });
    await pending;
    expect(event.messages).toHaveLength(3);
    expect((await host.rpc().status({ sessionID: "s" })).failed).toBe(false);
  });

  test("an Advisor failure fails open and reports failed", async () => {
    const host = await start({ advice: async () => Promise.reject(new Error("down")) });
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(event.messages).toHaveLength(3);
    expect((await host.rpc().status({ sessionID: "s" })).failed).toBe(true);
  });

  test("a Decision failure fails open", async () => {
    const host = await start({
      decision: async () => Promise.reject({ _tag: "Generate.ModelNotFoundError" }),
    });
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(event.messages).toHaveLength(3);
    expect(host.textCalls).toHaveLength(0);
  });

  test("child sessions lose the tool and are never routed", async () => {
    const host = await start();
    const event = request("child", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(event.tools).not.toHaveProperty("advisor");
    expect(host.decisionCalls).toHaveLength(0);
  });

  test("status reports the latest review from the entry", async () => {
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    const status = await host.rpc().status({ sessionID: "s" });
    expect(status).toMatchObject({
      mode: "active",
      sidebar: true,
      reviewing: false,
      configError: null,
    });
    expect(status.latest).toMatchObject({
      moment: "stuck",
      advice: "Check the token clock skew first.",
      details: { model: "mock/exec" },
    });
    expect(typeof status.latest.details.ms).toBe("number");
  });

  test("after a restart the stored review has no details", async () => {
    const first = await start();
    await first.hooks.context(request("s", [user("u1"), ...step(1)]));
    const host = await start();
    host.entries.s = first.entries.s;
    const status = await host.rpc().status({ sessionID: "s" });
    expect(status.latest).toMatchObject({ moment: "stuck", details: null });
  });
});

describe("observe", () => {
  test("records telemetry without blocking or changing the request", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    let release: (value: Any) => void = () => {};
    const host = await start({ decision: () => new Promise((resolve) => (release = resolve)) });
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(host.decisionCalls).toHaveLength(1);
    release(STUCK);
    await Bun.sleep(30);
    expect(event.messages).toHaveLength(3);
    expect(host.textCalls).toHaveLength(0);
    expect((await telemetryLines())[0]).toMatchObject({
      mode: "observe",
      verdict: "consult",
      delivered: false,
    });
  });
});

describe("invalid config", () => {
  test("behaves as off and surfaces the error", async () => {
    await writeConfig({ routing: { mode: "always" } });
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    expect(host.decisionCalls).toHaveLength(0);
    const status = await host.rpc().status({ sessionID: "s" });
    expect(status.mode).toBe("off");
    expect(status.configError).toContain("routing.mode");
  });
});

describe("explicit advisor()", () => {
  test("reviews the last request plus the in-flight call, without spending the budget", async () => {
    await writeConfig({ advisor: { model: "openai/gpt-6#high" } });
    const host = await start({ decision: async () => ROUTINE });
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    const result = await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "a-live", signal: new AbortController().signal });
    expect(result.content).toBe("Check the token clock skew first.");
    expect(host.textCalls[0].model).toEqual({ providerID: "openai", id: "gpt-6", variant: "high" });
    expect(host.textCalls[0].prompt).toContain("They've asked for your advice.");
    expect(host.textCalls[0].prompt).toContain("TOOL CALL advisor");
  });

  test("an invalid config fails the call instead of using the Executor's model", async () => {
    await writeConfig({ advisor: { model: "openai/gpt-6", unknown: true } });
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    const result = await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "a-live", signal: new AbortController().signal });
    expect(result.content).toContain("Advisor consultation failed");
    expect(result.content).toContain("unknown key: advisor.unknown");
    expect(host.textCalls).toHaveLength(0);
  });

  test("ignores the per-turn budget and the cooldown", async () => {
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    expect(host.textCalls).toHaveLength(1);
    const call = { sessionID: "s", messageID: "a-live", signal: new AbortController().signal };
    await host.tool().execute({}, call);
    await host.tool().execute({}, call);
    expect(host.textCalls).toHaveLength(3);
  });

  test("is refused in child sessions", async () => {
    const host = await start();
    const result = await host
      .tool()
      .execute({}, { sessionID: "child", messageID: "m", signal: new AbortController().signal });
    expect(result.content).toContain("only available in top-level sessions");
  });

  test("reports failures as tool output", async () => {
    const host = await start({ advice: async () => Promise.reject(new Error("down")) });
    await host.hooks.context(request("s", [user("u1")]));
    const result = await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "m", signal: new AbortController().signal });
    expect(result.content).toBe("Advisor consultation failed: all models failed (mock/exec: down)");
  });
});

describe("advisor context", () => {
  const catalog =
    '<mcp_instructions>\n  <server name="x">\n    Use it.\n  </server>\n</mcp_instructions>';
  const consultWith = async (config: unknown) => {
    await writeConfig(config);
    const host = await start();
    const event = request("s", [user("u1"), ...step(1)]);
    event.system.push({ type: "text", text: catalog });
    await host.hooks.context(event);
    await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "a-live", signal: new AbortController().signal });
    return { host, event };
  };

  test("compacts host catalogs in the Advisor's copy only", async () => {
    const { host, event } = await consultWith({});
    expect(host.textCalls[0].prompt).toContain(COMPACTED.mcp);
    expect(host.textCalls[0].prompt).not.toContain("<mcp_instructions>");
    expect(event.system.at(-1)?.text).toBe(catalog);
  });

  test("compactContext false sends the catalogs as they are", async () => {
    const { host } = await consultWith({ advisor: { compactContext: false } });
    expect(host.textCalls[0].prompt).toContain(catalog);
  });
});

describe("advisor budget", () => {
  // The fake catalog gives the Executor's model a 50k-token window: 75% is 37.5k tokens.
  const transcriptOf = (prompt: string) => prompt.slice(prompt.indexOf("EXECUTOR TRANSCRIPT"));
  const long = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      role: "assistant",
      id: `big${n}`,
      content: [{ type: "text", text: `${n}:${"x".repeat(2_000)}` }],
    }));
  const consultWith = async (config: unknown, messages: Any[]) => {
    await writeConfig(config);
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...messages]));
    await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "a-live", signal: new AbortController().signal });
    return transcriptOf(host.textCalls[0].prompt);
  };

  test("advisor.maxTokens caps a transcript the window would allow", async () => {
    const transcript = await consultWith({ advisor: { maxTokens: 1_000 } }, long(10));
    expect(transcript.length).toBeLessThanOrEqual(3_000 + 30);
    expect(transcript).toContain(OMISSION_MARKER);
    expect(transcript).toContain("9:xx");
  });

  test("a window smaller than advisor.maxTokens wins", async () => {
    const transcript = await consultWith({ advisor: { maxTokens: 1_000_000 } }, long(80));
    expect(transcript.length).toBeLessThanOrEqual(112_500 + 30);
    expect(transcript.length).toBeGreaterThan(100_000);
    expect(transcript).toContain(OMISSION_MARKER);
  });
});

describe("advisor chain", () => {
  const providerError = (reason: string) => ({ _tag: "Generate.ProviderRequestError", reason });

  test("an Advisor that fails hands over to the next; the answering model is reported", async () => {
    // Neither is the Executor's model, so the report cannot fall back to it.
    await writeConfig({ advisor: { model: ["mock/dead", "mock/small"] } });
    const host = await start({
      advice: async (input) =>
        input.model.id === "dead"
          ? Promise.reject(providerError("rate_limit"))
          : { text: "Check the token clock skew first." },
    });
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(host.textCalls.map((call) => call.model.id)).toEqual(["dead", "small"]);
    expect(tail(event).content[0].text).toContain("Check the token clock skew first.");
    await Bun.sleep(20);
    const [line] = await telemetryLines();
    expect(line.advisor).toMatchObject({ model: "mock/small", outcome: "ok" });
    expect(line.advisor.attempts.map((a: Any) => [a.model, a.outcome])).toEqual([
      ["mock/dead", "next"],
      ["mock/small", "ok"],
    ]);
    expect((await host.rpc().status({ sessionID: "s" })).latest.details.model).toBe("mock/small");
  });

  test("the explicit tool names every model's failure", async () => {
    // Routing off: an automatic consult would rate-limit mock/a first, and it would be skipped.
    await writeConfig({ advisor: { model: ["mock/a", "inherit"] }, routing: { mode: "off" } });
    const host = await start({
      advice: async (input) =>
        Promise.reject(
          input.model.id === "a"
            ? providerError("rate_limit")
            : { _tag: "Generate.UnavailableError" },
        ),
    });
    await host.hooks.context(request("s", [user("u1")]));
    const result = await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "m", signal: new AbortController().signal });
    expect(result.content).toBe(
      "Advisor consultation failed: all models failed (mock/a: Generate.ProviderRequestError (rate_limit), mock/exec: Generate.UnavailableError)",
    );
  });

  test("the transcript is rebuilt for each model's window", async () => {
    await writeConfig({ advisor: { model: ["inherit", "mock/small"] } });
    const host = await start({
      advice: async (input) =>
        input.model.id === "exec"
          ? Promise.reject(providerError("provider"))
          : { text: "Small model advice." },
    });
    const big = {
      role: "assistant",
      id: "big",
      content: [{ type: "text", text: "x".repeat(4_000) }],
    };
    await host.hooks.context(request("s", [user("u1"), big, ...step(1)]));
    expect(host.textCalls[0].prompt).not.toContain(OMISSION_MARKER);
    expect(host.textCalls[1].prompt).toContain(OMISSION_MARKER);
  });

  test("timeoutMs is one deadline for the chain; running out is a timeout", async () => {
    await writeConfig({ advisor: { model: ["inherit", "mock/small"], timeoutMs: 50 } });
    const host = await start({ advice: () => new Promise(() => {}) });
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    await Bun.sleep(20);
    const [line] = await telemetryLines();
    expect(line.advisor.outcome).toBe("timeout");
    expect(line.advisor.attempts.map((a: Any) => a.outcome)).toEqual(["timeout"]);
    expect((await host.rpc().status({ sessionID: "s" })).failed).toBe(true);
  });
});

describe("decision context in telemetry", () => {
  test("by default each request reaches the Decision model capped at 20,000 characters", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    const host = await start();
    await host.hooks.context(
      request("s", [user("u1", `HEAD${"p".repeat(30_000)}TAIL`), ...step(1)]),
    );
    await Bun.sleep(10);
    const input = host.decisionCalls[0].input[0].text;
    expect(input).toContain("USER: HEAD");
    expect(input).not.toContain("TAIL");
    expect(input).toContain("[10014 chars truncated]");
  });

  test("each line points at the newest message and keeps the Decision input", async () => {
    await writeConfig({ routing: { mode: "observe" } });
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    await Bun.sleep(10);
    const [line] = await telemetryLines();
    const input = host.decisionCalls[0].input[0].text;
    expect(line).toMatchObject({ message: "a1", input, inputChars: input.length });
  });

  test("a long input keeps its end, where the steps and counts are", async () => {
    // Uncapped, so the logged input is longer than the 32k telemetry keeps.
    await writeConfig({ routing: { mode: "observe", requestMaxChars: -1 } });
    const host = await start();
    await host.hooks.context(request("s", [user("u1", "p".repeat(50_000)), ...step(1)]));
    await Bun.sleep(10);
    const [line] = await telemetryLines();
    expect(line.inputChars).toBeGreaterThan(50_000);
    expect(line.input.length).toBeGreaterThan(31_900);
    expect(line.input.length).toBeLessThanOrEqual(32_000 + 40);
    expect(line.input).toContain("Recent steps this turn:");
    expect(line.input).toEndWith("Latest tool result: failed.");
  });

  test("an active step records them too", async () => {
    const host = await start();
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    await Bun.sleep(20);
    const [line] = await telemetryLines();
    expect(line.message).toBe("a1");
    expect(line.input).toContain("Recent steps this turn:");
  });
});

describe("advisor chain, failures", () => {
  test("an interrupt ends the chain; the next model is never asked", async () => {
    await writeConfig({ advisor: { model: ["inherit", "mock/small"] } });
    let release: () => void = () => {};
    const host = await start({
      advice: () => new Promise((resolve) => (release = () => resolve({ text: "late" }))),
    });
    const pending = host.hooks.context(request("s", [user("u1"), ...step(1)]));
    await Bun.sleep(5);
    await host.send({ type: "session.execution.interrupted", data: { sessionID: "s" } });
    await pending;
    release();
    await Bun.sleep(20);
    expect(host.textCalls.map((call) => call.model.id)).toEqual(["exec"]);
    expect((await telemetryLines())[0].advisor.outcome).toBe("stale");
  });

  test("a chain that timed out reports a timeout even when a later model was skipped", async () => {
    let first = true;
    const host = await start({
      advice: (input) => {
        // The first consult makes mock/small time out and skips it for 60 s.
        if (first && input.model.id === "exec")
          return Promise.reject({ _tag: "Generate.UnavailableError" });
        return new Promise(() => {});
      },
    });
    await writeConfig({
      advisor: { model: ["inherit", "mock/small"], timeoutMs: 40 },
      routing: { minStepsBetweenConsultations: 0 },
    });
    const history: Any[] = [user("u1"), ...step(1)];
    await host.hooks.context(request("s", [...history]));
    first = false;
    history.push(...step(2));
    await host.hooks.context(request("s", [...history]));
    await Bun.sleep(20);
    const [, second] = await telemetryLines();
    expect(second.advisor.attempts.map((a: Any) => a.outcome)).toEqual(["timeout", "skipped"]);
    expect(second.advisor.outcome).toBe("timeout");
  });
});
