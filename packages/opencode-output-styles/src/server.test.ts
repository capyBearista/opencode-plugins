import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import server from "./server.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed fake host context
type Any = any;

const CODING = "# Working in codebases\nUse tools carefully.\n\n# Tone\nBe nice.";
const REMINDER = (name: string, text: string) =>
  `<system-reminder>\n${name} output style is active. ${text}\n</system-reminder>`;

let root: string;
let project: string;
let savedConfigDir: string | undefined;

async function writeStyle(file: string, content: string) {
  const dir = join(project, ".opencode", "output-styles");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "output-styles-server-"));
  project = join(root, "project");
  await mkdir(project, { recursive: true });
  savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "config");
  await writeStyle(
    "terse.md",
    "---\nname: Terse\ndescription: Short.\nturn-reminder: Stay terse.\n---\nBe terse.\n",
  );
  await writeStyle("lean.md", "---\nname: Lean\nkeep-coding-instructions: false\n---\nBe lean.\n");
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
  await rm(root, { recursive: true, force: true });
});

interface Setup {
  sessions?: Record<string, Any>;
  stored?: Record<string, unknown>;
  options?: Record<string, unknown>;
  agent?: Any;
  sessionGetThrows?: boolean;
  context?: Any[];
  contextThrows?: boolean;
}

async function start(config: Setup = {}) {
  const sessions: Record<string, Any> = config.sessions ?? {};
  const stored: Record<string, unknown> = { ...config.stored };
  const updates: Any[] = [];
  const agentCalls: string[] = [];
  const disposed: string[] = [];
  let hook: Any;
  let handlers: Any;

  const ctx: Any = {
    options: config.options ?? {},
    location: { project: { directory: project } },
    storage: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: unknown) => {
        stored[key] = value;
      },
      remove: async (key: string) => {
        delete stored[key];
      },
    },
    session: {
      get: async ({ sessionID }: Any) => {
        if (config.sessionGetThrows) throw new Error("boom");
        const session = sessions[sessionID];
        if (!session) throw new Error("not found");
        return session;
      },
      context: async () => {
        if (config.contextThrows) throw new Error("no context");
        return (
          config.context ?? [
            { id: "m1", type: "user" },
            { id: "m3", type: "user" },
          ]
        );
      },
      update: async (input: Any) => {
        updates.push(input);
      },
      hook: async (name: string, callback: Any) => {
        expect(name).toBe("context");
        hook = callback;
        return { dispose: async () => void disposed.push("hook") };
      },
    },
    agent: {
      get: async ({ agentID }: Any) => {
        agentCalls.push(agentID);
        return { data: config.agent ?? {} };
      },
    },
    rpc: {
      register: async (_definition: Any, impl: Any) => {
        handlers = impl;
        return { dispose: async () => void disposed.push("rpc") };
      },
    },
  };

  const cleanup = await server.setup(ctx);
  const error = (code: string, message: string, data: unknown) => ({ code, message, data });
  const call = (name: string, input: unknown) => handlers[name](input, { error });
  const run = (event: Partial<Any> = {}) => {
    const e: Any = {
      sessionID: "s1",
      agent: "build",
      system: [{ type: "text", text: CODING }],
      messages: [
        { role: "user", id: "m1", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", id: "m2", content: [{ type: "text", text: "hello" }] },
        { role: "user", id: "m3", content: [{ type: "text", text: "again" }] },
      ],
      ...event,
    };
    const before = structuredClone({ system: e.system, messages: e.messages });
    return { e, before, done: hook(e) };
  };
  return { call, run, updates, agentCalls, disposed, stored, cleanup: cleanup as Any };
}

describe("context hook", () => {
  test("leaves the request untouched when no style is set", async () => {
    const t = await start({ sessions: { s1: {} } });
    const { e, before, done } = t.run();
    await done;
    expect({ system: e.system, messages: e.messages }).toEqual(before);
  });

  test("applies the session style to system and every real prompt", async () => {
    const t = await start({ sessions: { s1: { metadata: { outputStyle: "terse" } } } });
    const { e, before, done } = t.run();
    await done;
    const reminder = REMINDER("Terse", "Stay terse.");
    expect(e.system).toEqual([...before.system, { type: "text", text: "Be terse." }]);
    expect(e.messages[0].content.at(-1)).toEqual({ type: "text", text: reminder });
    expect(e.messages[2].content.at(-1)).toEqual({ type: "text", text: reminder });
    expect(e.messages[1]).toEqual(before.messages[1]);
  });

  test("falls back to the stored default style", async () => {
    const t = await start({ sessions: { s1: {} }, stored: { "default-style": "terse" } });
    const { e, done } = t.run();
    await done;
    expect(e.system.at(-1).text).toBe("Be terse.");
  });

  test("session metadata default overrides a stored default", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "default" } } },
      stored: { "default-style": "terse" },
    });
    const { e, before, done } = t.run();
    await done;
    expect({ system: e.system, messages: e.messages }).toEqual(before);
  });

  test("skips child sessions even with inherited metadata", async () => {
    const t = await start({
      sessions: { s1: { parentID: "p", metadata: { outputStyle: "terse" } } },
    });
    const { e, before, done } = t.run();
    await done;
    expect({ system: e.system, messages: e.messages }).toEqual(before);
  });

  test("ignores an unknown style id without throwing", async () => {
    const t = await start({ sessions: { s1: { metadata: { outputStyle: "nope" } } } });
    const { e, before, done } = t.run();
    await done;
    expect({ system: e.system, messages: e.messages }).toEqual(before);
  });

  test("reminds only real prompts, not synthetic, skill or compaction user messages", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "terse" } } },
      context: [
        { id: "m1", type: "user" },
        { id: "syn", type: "synthetic" },
        { id: "sk", type: "skill" },
        { id: "cp", type: "compaction" },
      ],
    });
    const user = (id?: string) => ({ role: "user", id, content: [{ type: "text", text: id }] });
    const messages = [user("m1"), user("syn"), user("sk"), user("cp"), user()];
    await t.run({ messages }).done;
    const reminded = messages.map((m) => m.content.length > 1);
    expect(reminded).toEqual([true, false, false, false, false]);
  });

  test("still applies the system style when session.context throws", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "terse" } } },
      contextThrows: true,
    });
    const { e, before, done } = t.run();
    await done;
    expect(e.system.at(-1).text).toBe("Be terse.");
    expect(e.messages).toEqual(before.messages);
  });

  test("strips coding sections when the agent has no own system prompt", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "lean" } } },
      agent: {},
    });
    const { e, done } = t.run();
    await done;
    expect(e.system[0].text).not.toContain("# Working in codebases");
    expect(e.system[0].text).toContain("# Tone");
    expect(t.agentCalls).toEqual(["build"]);
  });

  test("keeps the base prompt when the agent has its own system prompt", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "lean" } } },
      agent: { system: "custom" },
    });
    const { e, done } = t.run();
    await done;
    expect(e.system[0].text).toBe(CODING);
    expect(e.system.at(-1).text).toBe("Be lean.");
  });

  test("does not look up the agent when coding instructions are kept", async () => {
    const t = await start({ sessions: { s1: { metadata: { outputStyle: "terse" } } } });
    await t.run().done;
    expect(t.agentCalls).toEqual([]);
  });

  test("swallows errors", async () => {
    const t = await start({ sessionGetThrows: true });
    const { e, before, done } = t.run();
    await done;
    expect({ system: e.system, messages: e.messages }).toEqual(before);
  });
});

describe("rpc setSessionStyle", () => {
  test("merges into existing metadata", async () => {
    const t = await start({ sessions: { s1: { metadata: { foreign: 1 } } } });
    const result = await t.call("setSessionStyle", { sessionID: "s1", style: "terse" });
    expect(result).toEqual({ style: "terse" });
    expect(t.updates).toEqual([
      { sessionID: "s1", metadata: { foreign: 1, outputStyle: "terse" } },
    ]);
  });

  test("resolves names case-insensitively", async () => {
    const t = await start({ sessions: { s1: {} } });
    expect(await t.call("setSessionStyle", { sessionID: "s1", style: "CONCISE" })).toEqual({
      style: "concise",
    });
    expect(await t.call("setSessionStyle", { sessionID: "s1", style: " Terse " })).toEqual({
      style: "terse",
    });
  });

  test("stores default explicitly", async () => {
    const t = await start({ sessions: { s1: {} } });
    expect(await t.call("setSessionStyle", { sessionID: "s1", style: "Default" })).toEqual({
      style: "default",
    });
    expect(t.updates[0].metadata).toEqual({ outputStyle: "default" });
  });

  test("returns unknown_style for unknown styles without writing", async () => {
    const t = await start({ sessions: { s1: {} } });
    const result = await t.call("setSessionStyle", { sessionID: "s1", style: "nope" });
    expect(result).toMatchObject({ code: "unknown_style", data: { style: "nope" } });
    expect(t.updates).toEqual([]);
  });
});

describe("subagent sessions", () => {
  test("setSessionStyle refuses child sessions without writing", async () => {
    const t = await start({ sessions: { c1: { parentID: "p" } } });
    const result = await t.call("setSessionStyle", { sessionID: "c1", style: "terse" });
    expect(result).toMatchObject({ code: "subagent_session", data: { sessionID: "c1" } });
    expect(t.updates).toEqual([]);
  });

  test("clearSessionStyle refuses child sessions without writing", async () => {
    const t = await start({ sessions: { c1: { parentID: "p", metadata: { outputStyle: "x" } } } });
    const result = await t.call("clearSessionStyle", { sessionID: "c1" });
    expect(result).toMatchObject({ code: "subagent_session", data: { sessionID: "c1" } });
    expect(t.updates).toEqual([]);
  });
});

describe("rpc clearSessionStyle", () => {
  test("removes only the output style key", async () => {
    const t = await start({
      sessions: { s1: { metadata: { foreign: 1, outputStyle: "terse" } } },
    });
    expect(await t.call("clearSessionStyle", { sessionID: "s1" })).toEqual({ sessionID: "s1" });
    expect(t.updates).toEqual([{ sessionID: "s1", metadata: { foreign: 1 } }]);
  });
});

describe("rpc setDefaultStyle", () => {
  test("sets, removes and rejects", async () => {
    const t = await start();
    expect(await t.call("setDefaultStyle", { style: "Terse" })).toEqual({ style: "terse" });
    expect(t.stored["default-style"]).toBe("terse");

    expect(await t.call("setDefaultStyle", { style: "default" })).toEqual({ style: "default" });
    expect("default-style" in t.stored).toBe(false);

    t.stored["default-style"] = "terse";
    const result = await t.call("setDefaultStyle", { style: "nope" });
    expect(result).toMatchObject({ code: "unknown_style" });
    expect(t.stored["default-style"]).toBe("terse");
  });
});

describe("rpc state", () => {
  test("reports sidebar option", async () => {
    expect((await (await start()).call("state", {})).sidebar).toBe(true);
    expect((await (await start({ options: { sidebar: false } })).call("state", {})).sidebar).toBe(
      false,
    );
    expect((await (await start({ options: { sidebar: "no" } })).call("state", {})).sidebar).toBe(
      true,
    );
  });

  test("reports whether the session is a subagent session", async () => {
    const t = await start({ sessions: { c1: { parentID: "p" }, s1: {} } });
    expect((await t.call("state", { sessionID: "c1" })).subagent).toBe(true);
    expect((await t.call("state", { sessionID: "s1" })).subagent).toBe(false);
    expect((await t.call("state", {})).subagent).toBe(false);
  });

  test("reports default and session styles", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "terse" } } },
      stored: { "default-style": "lean" },
    });
    const state = await t.call("state", { sessionID: "s1" });
    expect(state).toMatchObject({ defaultStyle: "lean", sessionStyle: "terse" });

    const none = await (await start()).call("state", { sessionID: "missing" });
    expect(none).toMatchObject({ defaultStyle: null, sessionStyle: null });
    expect(await (await start()).call("state", {})).toMatchObject({ sessionStyle: null });
  });

  test("defaultStyle resolves to the canonical id or null", async () => {
    const ghost = await start({ stored: { "default-style": "ghost" } });
    expect((await ghost.call("state", {})).defaultStyle).toBeNull();
    const byName = await start({ stored: { "default-style": "Terse" } });
    expect((await byName.call("state", {})).defaultStyle).toBe("terse");
  });

  test("sessionStyle stays raw even when it does not resolve", async () => {
    const t = await start({ sessions: { s1: { metadata: { outputStyle: "ghost" } } } });
    expect((await t.call("state", { sessionID: "s1" })).sessionStyle).toBe("ghost");
  });

  test("lists built-ins first, then others alphabetically, with sources", async () => {
    await writeStyle("a.md", "---\nname: Zed\n---\nZ.\n");
    await writeStyle("b.md", "---\nname: Alpha\n---\nA.\n");
    await writeStyle("concise.md", "---\nname: Concise\n---\nProject concise.\n");
    const { styles } = await (await start()).call("state", {});
    const sources = styles.map((s: Any) => s.source);
    const firstOther = sources.findIndex((s: string) => s !== "built-in");
    expect(firstOther).toBeGreaterThan(0);
    expect(sources.slice(firstOther)).not.toContain("built-in");
    expect(styles.slice(firstOther).map((s: Any) => s.id)).toEqual([
      "b",
      "concise",
      "lean",
      "terse",
      "a",
    ]);
    expect(styles.find((s: Any) => s.id === "concise").source).toBe("project");
    expect(styles.find((s: Any) => s.id === "terse")).toEqual({
      id: "terse",
      name: "Terse",
      description: "Short.",
      source: "project",
    });
    expect(sources).toContain("built-in");
  });
});

test("cleanup disposes the hook and rpc registrations", async () => {
  const t = await start();
  expect(t.disposed).toEqual([]);
  await t.cleanup();
  expect(t.disposed.sort()).toEqual(["hook", "rpc"]);
});
