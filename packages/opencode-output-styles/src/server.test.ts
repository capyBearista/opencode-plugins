import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY_KEY, REMINDER_METADATA_KEY } from "./prompt.js";
import server from "./server.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed fake host context
type Any = any;

const REMINDER = (name: string, text: string) =>
  `<system-reminder>\n${name} output style is active. ${text}\n</system-reminder>`;
const TERSE_ENTRY = "Terse output style\n\nBe terse.";

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
  await writeStyle("lean.md", "---\nname: Lean\n---\nBe lean.\n");
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
  entries?: Record<string, Record<string, unknown>>;
  sessionGetThrows?: boolean;
  context?: Any[];
  contextThrows?: boolean;
}

async function start(config: Setup = {}) {
  const sessions: Record<string, Any> = config.sessions ?? {};
  const stored: Record<string, unknown> = { ...config.stored };
  const entries: Record<string, Record<string, unknown>> = structuredClone(config.entries ?? {});
  const updates: Any[] = [];
  const entryWrites: Any[] = [];
  const disposed: string[] = [];
  const hooks: Record<string, Any> = {};
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
        return config.context ?? [];
      },
      update: async (input: Any) => {
        updates.push(input);
      },
      instructions: {
        entry: {
          list: async ({ sessionID }: Any) =>
            Object.entries(entries[sessionID] ?? {}).map(([key, value]) => ({ key, value })),
          put: async ({ sessionID, key, value }: Any) => {
            entryWrites.push({ op: "put", sessionID, key, value });
            entries[sessionID] = { ...entries[sessionID], [key]: value };
          },
          remove: async ({ sessionID, key }: Any) => {
            entryWrites.push({ op: "remove", sessionID, key });
            delete entries[sessionID]?.[key];
          },
        },
      },
      hook: async (name: string, callback: Any) => {
        hooks[name] = callback;
        return { dispose: async () => void disposed.push(`hook:${name}`) };
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
  const prompt = async (event: Partial<Any> = {}) => {
    const e: Any = {
      sessionID: "s1",
      messageID: "m9",
      prompt: { text: "hi" },
      delivery: "steer",
      ...event,
    };
    await hooks.prompt(e);
    return e;
  };
  const request = async (messages: Any[]) => {
    const e: Any = {
      sessionID: "s1",
      agent: "build",
      system: [{ type: "text", text: "S" }],
      messages,
    };
    await hooks.context(e);
    return e;
  };
  return {
    call,
    prompt,
    request,
    hooks,
    updates,
    entries,
    entryWrites,
    disposed,
    stored,
    cleanup: cleanup as Any,
  };
}

describe("prompt hook", () => {
  test("registers the prompt and context hooks", async () => {
    const t = await start();
    expect(Object.keys(t.hooks).sort()).toEqual(["context", "prompt"]);
  });

  test("puts the session style as an entry and records its reminder on the prompt", async () => {
    const t = await start({ sessions: { s1: { metadata: { outputStyle: "terse" } } } });
    const e = await t.prompt({ metadata: { foreign: 1 } });
    expect(t.entries.s1).toEqual({ [ENTRY_KEY]: TERSE_ENTRY });
    expect(e.metadata).toEqual({
      foreign: 1,
      [REMINDER_METADATA_KEY]: REMINDER("Terse", "Stay terse."),
    });
  });

  test("falls back to the stored default style", async () => {
    const t = await start({ sessions: { s1: {} }, stored: { "default-style": "terse" } });
    await t.prompt();
    expect(t.entries.s1?.[ENTRY_KEY]).toBe(TERSE_ENTRY);
  });

  test("does not rewrite an entry that already holds the style", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "terse" } } },
      entries: { s1: { [ENTRY_KEY]: TERSE_ENTRY } },
    });
    await t.prompt();
    expect(t.entryWrites).toEqual([]);
  });

  test("replaces the entry when the style changes", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "lean" } } },
      entries: { s1: { [ENTRY_KEY]: TERSE_ENTRY } },
    });
    await t.prompt();
    expect(t.entries.s1?.[ENTRY_KEY]).toBe("Lean output style\n\nBe lean.");
  });

  test("removes the entry and records no reminder when the session has no style", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "default" } } },
      stored: { "default-style": "terse" },
      entries: { s1: { [ENTRY_KEY]: TERSE_ENTRY, other: "keep" } },
    });
    const e = await t.prompt();
    expect(t.entries.s1).toEqual({ other: "keep" });
    expect(e.metadata).toBeUndefined();
  });

  test("writes nothing when no style is set and no entry exists", async () => {
    const t = await start({ sessions: { s1: {} } });
    const e = await t.prompt();
    expect(t.entryWrites).toEqual([]);
    expect(e.metadata).toBeUndefined();
  });

  test("treats an unknown style id as no style", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "nope" } } },
      entries: { s1: { [ENTRY_KEY]: TERSE_ENTRY } },
    });
    const e = await t.prompt();
    expect(t.entries.s1).toEqual({});
    expect(e.metadata).toBeUndefined();
  });

  test("skips child sessions even with inherited metadata", async () => {
    const t = await start({
      sessions: { s1: { parentID: "p", metadata: { outputStyle: "terse" } } },
    });
    const e = await t.prompt();
    expect(t.entryWrites).toEqual([]);
    expect(e.metadata).toBeUndefined();
  });

  test("swallows errors", async () => {
    const t = await start({ sessionGetThrows: true });
    const e = await t.prompt();
    expect(t.entryWrites).toEqual([]);
    expect(e.metadata).toBeUndefined();
  });
});

describe("context hook", () => {
  const user = (id: string, text = id) => ({ role: "user", id, content: [{ type: "text", text }] });

  test("attaches each prompt's recorded reminder and nothing else", async () => {
    const t = await start({
      context: [
        { id: "m1", type: "user", metadata: { [REMINDER_METADATA_KEY]: "<r>old</r>" } },
        { id: "m2", type: "assistant" },
        { id: "m3", type: "user", metadata: { [REMINDER_METADATA_KEY]: "<r>new</r>" } },
        { id: "m4", type: "user" },
        { id: "syn", type: "synthetic", metadata: { [REMINDER_METADATA_KEY]: "<r>x</r>" } },
      ],
    });
    const messages = [user("m1"), user("m3"), user("m4"), user("syn")];
    const e = await t.request(messages);
    expect(e.messages.map((m: Any) => m.content.map((c: Any) => c.text))).toEqual([
      ["m1", "<r>old</r>"],
      ["m3", "<r>new</r>"],
      ["m4"],
      ["syn"],
    ]);
    expect(e.system).toEqual([{ type: "text", text: "S" }]);
  });

  test("never touches the system prompt", async () => {
    const t = await start({
      sessions: { s1: { metadata: { outputStyle: "terse" } } },
      context: [{ id: "m1", type: "user" }],
    });
    const e = await t.request([user("m1")]);
    expect(e.system).toEqual([{ type: "text", text: "S" }]);
    expect(e.messages[0].content).toHaveLength(1);
  });

  test("leaves the request untouched when session.context throws", async () => {
    const t = await start({ contextThrows: true });
    const e = await t.request([user("m1")]);
    expect(e.messages[0].content).toHaveLength(1);
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

test("cleanup disposes both hooks and the rpc registration", async () => {
  const t = await start();
  expect(t.disposed).toEqual([]);
  await t.cleanup();
  expect(t.disposed.sort()).toEqual(["hook:context", "hook:prompt", "rpc"]);
});
