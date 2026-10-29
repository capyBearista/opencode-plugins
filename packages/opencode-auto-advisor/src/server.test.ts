import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  advice?: () => Promise<{ text: string }>;
  parent?: string;
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
          return setup.advice ? setup.advice() : { text: "Check the token clock skew first." };
        },
      },
    },
    model: {
      list: async () => ({
        data: [{ providerID: "mock", id: "exec", limit: { context: 50_000 } }],
      }),
    },
    session: {
      get: async ({ sessionID }: Any) => ({
        id: sessionID,
        parentID: sessionID === "child" ? "root" : undefined,
      }),
      context: async () => [
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

describe("off (default)", () => {
  test("registers the advisor tool and never calls the Decision model", async () => {
    const host = await start();
    expect(host.tool().name).toBe("advisor");
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);
    expect(host.decisionCalls).toHaveLength(0);
    expect(event.messages).toHaveLength(3);
  });
});

describe("active", () => {
  beforeEach(() => writeConfig({ routing: { mode: "active" } }));

  test("an accepted moment delivers the review now and stores it for later steps", async () => {
    const host = await start();
    const event = request("s", [user("u1"), ...step(1)]);
    await host.hooks.context(event);

    expect(host.decisionCalls[0].model).toEqual({ providerID: "opencode", id: "jev-1.13-free" });
    expect(host.textCalls[0].model).toEqual({ providerID: "mock", id: "exec" });
    expect(host.textCalls[0].prompt).toContain("stuck on a recurring failure");
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
    const host = await start();
    const history: Any[] = [user("u1")];
    for (let n = 1; n <= 3; n++) {
      history.push(...step(n));
      await host.hooks.context(request("s", [...history]));
    }
    expect(host.textCalls).toHaveLength(2);
    expect(host.decisionCalls).toHaveLength(2);
    await host.hooks.context(request("s", [...history, user("u2", "next")]));
    expect(host.textCalls).toHaveLength(3);
  });

  test("a synthetic user message mid-turn does not reset the budget", async () => {
    const host = await start();
    await host.hooks.prompt({ sessionID: "s", messageID: "u1", delivery: "steer" });
    const history: Any[] = [user("u1")];
    for (let n = 1; n <= 2; n++) {
      history.push(...step(n));
      await host.hooks.context(request("s", [...history]));
    }
    history.push(user("synthetic-1", "skill output"), ...step(3));
    await host.hooks.context(request("s", [...history]));
    expect(host.textCalls).toHaveLength(2);
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
    expect(status).toMatchObject({ mode: "active", reviewing: false, configError: null });
    expect(status.latest).toMatchObject({
      moment: "stuck",
      advice: "Check the token clock skew first.",
    });
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
    await writeConfig({
      routing: { mode: "active", maxConsultationsPerTurn: 1 },
      advisor: { model: "openai/gpt-6#high" },
    });
    const host = await start({ decision: async () => ROUTINE });
    await host.hooks.context(request("s", [user("u1"), ...step(1)]));
    const result = await host
      .tool()
      .execute({}, { sessionID: "s", messageID: "a-live", signal: new AbortController().signal });
    expect(result.content).toBe("Check the token clock skew first.");
    expect(host.textCalls[0].model).toEqual({ providerID: "openai", id: "gpt-6", variant: "high" });
    expect(host.textCalls[0].prompt).toContain("The Executor asked for this review.");
    expect(host.textCalls[0].prompt).toContain("TOOL CALL advisor");
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
    expect(result.content).toBe("Advisor consultation failed: down");
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
