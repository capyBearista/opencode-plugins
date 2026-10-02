import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ADVISOR_DELIVERY_PREFIX } from "./advice-delivery.js";
import { defaultConfig } from "./config.js";
import plugin, { ADVISOR_TOOL_DESCRIPTION, ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";
import { retainedReviewKey } from "./retained-review.js";

type AddedTool = {
  name: string;
  description: string;
  input: {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: unknown;
  };
  options?: { codemode?: boolean; permission?: string };
  execute: (input: unknown, context: unknown) => Promise<{ content?: string }>;
};

export function createTestContext() {
  const added: AddedTool[] = [];
  const disposers: string[] = [];
  const hooks: string[] = [];
  const hookCallbacks = new Map<string, (input: unknown) => Promise<void> | void>();
  const ctx = {
    tool: {
      transform: async (callback: (editor: { add: (tool: AddedTool) => void }) => void) => {
        callback({
          add: (tool) => {
            added.push(tool);
          },
        });
        return {
          dispose: async () => {
            disposers.push(`tool:${added.at(-1)?.name ?? "unknown"}`);
          },
        };
      },
    },
    session: {
      hook: async (name: string, callback: (input: unknown) => Promise<void> | void) => {
        hooks.push(name);
        hookCallbacks.set(name, callback);
        return {
          dispose: async () => {
            disposers.push(`hook:${name}`);
          },
        };
      },
      get: async () => ({ parentID: undefined, permissions: [] }),
    },
    agent: {
      get: async () => ({ location: { directory: "/tmp" }, data: { permissions: [] } }),
    },
    model: {
      list: async () => ({
        data: [
          {
            id: "jev-1.13",
            providerID: "opencode",
            modelID: "jev-1.13",
            limit: { context: 200_000, output: 32_000 },
          },
          {
            id: "jev-1.14",
            providerID: "opencode",
            modelID: "jev-1.14",
            limit: { context: 200_000, output: 32_000 },
          },
          {
            id: "claude-sonnet-4",
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
            limit: { context: 200_000, output: 32_000 },
          },
        ],
      }),
    },
  };
  return { ctx, added, disposers, hooks, hookCallbacks };
}

describe("@capybearista/opencode-auto-advisor", () => {
  test("exports a V2 plugin definition with the package id", () => {
    expect(plugin.id).toBe("capybearista.opencode-auto-advisor");
    expect(plugin.setup).toBeFunction();
    expect("server" in plugin).toBe(false);
    expect("tui" in plugin).toBe(false);
  });

  test("setup registers one zero-argument advisor tool and one context hook, and disposes both once", async () => {
    const context = createTestContext();
    const cleanup = await plugin.setup(context.ctx as never);

    expect(context.added).toHaveLength(1);
    const tool = context.added[0];
    expect(tool?.name).toBe(ADVISOR_TOOL_NAME);
    expect(tool?.input).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(tool?.input.required).toBeUndefined();
    expect(tool?.description).toBe(ADVISOR_TOOL_DESCRIPTION);
    expect(tool?.description).toContain("no arguments");
    expect(tool?.options).toEqual({ codemode: false, permission: ADVISOR_TOOL_NAME });

    expect(context.hooks).toEqual(["context"]);
    expect(context.hookCallbacks.get("context")).toBeFunction();

    expect(typeof cleanup).toBe("function");
    await cleanup?.();
    await cleanup?.();
    expect(context.disposers).toEqual(["hook:context", `tool:${ADVISOR_TOOL_NAME}`]);
  });

  test("package.json keeps distinct package-root server and TUI entries", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(Object.keys(manifest.exports)).toEqual([".", "./tui"]);
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    expect(manifest.exports["./tui"].default).toBe("./dist/tui.js");
    expect(manifest.exports["."].default).not.toBe(manifest.exports["./tui"].default);
    expect(manifest.files).toEqual(["dist", "server.js", "tui.js"]);
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.peerDependencies["@opencode/plugin"]).toBe("2.0.21");
    expect(manifest.peerDependencies["@opencode/ai"]).toBe("2.0.21");
  });

  test("full host context wires telemetry storage, rpc, delivery, and event cleanup", async () => {
    const base = createTestContext();
    const values = new Map<string, unknown>();
    const rpcIDs: string[] = [];
    const signals: AbortSignal[] = [];
    const ctx = {
      ...base.ctx,
      generate: { text: async () => ({ text: "advice" }) },
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        remove: async (key: string) => {
          values.delete(key);
        },
        scan: async () => ({ entries: [] }),
      },
      rpc: {
        register: async (definition: { id: string }) => {
          rpcIDs.push(definition.id);
          return {
            dispose: async () => {
              base.disposers.push(`rpc:${definition.id}`);
            },
            events: { emit: async () => undefined },
          };
        },
      },
      event: {
        subscribe: (options: { signal?: AbortSignal }) => {
          if (options.signal) signals.push(options.signal);
          return (async function* () {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        },
      },
    };
    const cleanup = await registerPlugin(ctx as never, {
      loadConfig: async () => ({
        ...defaultConfig(),
        routing: { ...defaultConfig().routing, mode: "active" },
      }),
      router: { evaluate: async () => ({ advisorWouldHelp: 0.9, consequence: 4 }) },
    });

    const dispatch = {
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "opencode", id: "jev-1.13" },
      system: [],
      messages: [{ id: "msg-user-1", role: "user", content: [{ type: "text", text: "hi" }] }],
      options: {},
      tools: { advisor: { description: "advisor", input: { type: "object" } } },
    };
    await base.hookCallbacks.get("context")?.(dispatch);

    expect(dispatch.messages).toEqual([
      { id: "msg-user-1", role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(dispatch.messages.some((message) => message.role === "system")).toBe(false);
    expect(dispatch.system).toHaveLength(2);
    expect(dispatch.system.every((part) => part.type === "text")).toBe(true);
    expect(dispatch.system[0]?.text).toContain("advisor()");
    const delivered = dispatch.system.filter((part) =>
      part.text?.includes(ADVISOR_DELIVERY_PREFIX),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("advice");
    expect(base.hooks).toEqual(["context"]);
    expect(rpcIDs).toEqual(["experimental.auto-advisor", "experimental.auto-advisor.review"]);
    expect(values.has("head")).toBe(true);
    const stored = [...values.values()].find(
      (value) => (value as { decision?: string }).decision === "accept",
    );
    expect(stored).toMatchObject({ mode: "active", delivered: true });
    expect(values.get(retainedReviewKey("ses_1" as never))).toMatchObject({ advice: "advice" });
    expect(signals).toHaveLength(1);

    await cleanup?.();
    expect(signals[0]?.aborted).toBe(true);
    expect(base.disposers).toEqual([
      "hook:context",
      "rpc:experimental.auto-advisor.review",
      "rpc:experimental.auto-advisor",
      `tool:${ADVISOR_TOOL_NAME}`,
    ]);
  });

  test("real V2 host resolves the package root server and TUI entries", () => {
    const packageRoot = join(import.meta.dir, "..");
    const packageName = "@capybearista/opencode-auto-advisor";
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
          import * as Host from "@opencode/plugin/host";
          const root = ${JSON.stringify(packageRoot)};
          const local = Host.resolve({ directory: root });
          const named = Host.resolve({ directory: root, name: ${JSON.stringify(packageName)} });
          process.stdout.write(JSON.stringify({
            local: { server: local.server ?? null, tui: local.tui ?? null, rpc: local.rpc ?? null },
            named: { server: named.server ?? null, tui: named.tui ?? null, rpc: named.rpc ?? null },
          }));
        `,
      ],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }

    const resolved = JSON.parse(new TextDecoder().decode(child.stdout)) as {
      local: { server: string | null; tui: string | null; rpc: string | null };
      named: { server: string | null; tui: string | null; rpc: string | null };
    };

    expect(resolved.local).toEqual({
      server: pathToFileURL(join(packageRoot, "server.js")).href,
      tui: pathToFileURL(join(packageRoot, "tui.js")).href,
      rpc: null,
    });
    expect(resolved.named).toEqual({
      server: pathToFileURL(join(packageRoot, "dist", "index.js")).href,
      tui: pathToFileURL(join(packageRoot, "dist", "tui.js")).href,
      rpc: null,
    });
    expect(resolved.local.server).not.toBe(resolved.local.tui);
    expect(resolved.named.server).not.toBe(resolved.named.tui);
    expect(resolved.named.server).not.toBe(resolved.local.server);
    expect(resolved.named.tui).not.toBe(resolved.local.tui);
  });
});

interface Gate {
  readonly started: Promise<void>;
  readonly promise: Promise<void>;
  readonly markStarted: () => void;
  readonly release: () => void;
}

function gated(): Gate {
  let release: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, promise, markStarted, release: () => release() };
}

const ticks = async (count = 3): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function pluginStorage(writeGate?: { hold: () => Promise<void> }) {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      if (key === retainedReviewKey("ses_1" as never)) await writeGate?.hold();
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
    scan: async () => ({ entries: [] }),
  };
}

function storedReview(values: Map<string, unknown>): string | undefined {
  const value = values.get(retainedReviewKey("ses_1" as never)) as
    | { readonly advice?: string }
    | undefined;
  return value?.advice;
}

function retainedWriteGate() {
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    hold: async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release?.(),
  };
}

async function compositionHarness(
  options: {
    readonly sessionGet?: () => Promise<{ readonly parentID?: string } | undefined>;
    readonly holdContextDisposer?: Gate;
    readonly writeGate?: { hold: () => Promise<void> };
  } = {},
) {
  const base = createTestContext();
  const storage = pluginStorage(options.writeGate);
  const pushes: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const signals: AbortSignal[] = [];
  const ctx = {
    ...base.ctx,
    storage,
    generate: { text: async () => ({ text: "advisor advice" }) },
    session: {
      ...base.ctx.session,
      ...(options.sessionGet ? { get: options.sessionGet } : {}),
      hook: async (name: string, callback: (input: unknown) => Promise<void> | void) => {
        base.hooks.push(name);
        base.hookCallbacks.set(name, callback);
        return {
          dispose: async () => {
            base.disposers.push(`hook:${name}`);
            if (name === "context" && options.holdContextDisposer) {
              options.holdContextDisposer.markStarted();
              await options.holdContextDisposer.promise;
            }
          },
        };
      },
    },
    event: {
      subscribe: (subscribeOptions: { readonly signal?: AbortSignal }) => {
        if (subscribeOptions.signal) signals.push(subscribeOptions.signal);
        return (async function* () {
          while (!closed) {
            if (pushes.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
                subscribeOptions.signal?.addEventListener(
                  "abort",
                  () => {
                    closed = true;
                    resolve();
                  },
                  { once: true },
                );
              });
            }
            while (pushes.length > 0) yield pushes.shift();
          }
        })();
      },
    },
  };
  const cleanup = await registerPlugin(ctx as never, {
    loadConfig: async () => ({
      ...defaultConfig(),
      routing: { ...defaultConfig().routing, mode: "active" },
    }),
    router: { evaluate: async () => ({ advisorWouldHelp: 0.9, consequence: 4 }) },
  });
  return {
    base,
    cleanup,
    values: storage.values,
    signals,
    fire: (name: string, input: unknown) => base.hookCallbacks.get(name)?.(input),
    push: (payload: unknown) => {
      pushes.push(payload);
      wake?.();
      wake = undefined;
    },
  };
}

function primaryDispatch() {
  return {
    sessionID: "ses_1",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [] as Array<{ type: string; text: string }>,
    messages: [{ id: "msg-user-1", role: "user", content: [{ type: "text", text: "hi" }] }],
    options: {},
    tools: { advisor: { description: "advisor", input: { type: "object" } } },
  };
}

describe("plugin storage fail-open", () => {
  test("a throwing ctx.storage write never rewrites accept and still delivers", async () => {
    const base = createTestContext();
    const values = new Map<string, unknown>();
    const ctx = {
      ...base.ctx,
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          if (key.startsWith("auto-advisor:retained:")) throw new Error("storage write rejected");
          values.set(key, value);
        },
        remove: async (key: string) => {
          values.delete(key);
        },
        scan: async () => ({ entries: [] }),
      },
      generate: { text: async () => ({ text: "advisor advice" }) },
    };
    await registerPlugin(ctx as never, {
      loadConfig: async () => ({
        ...defaultConfig(),
        routing: { ...defaultConfig().routing, mode: "active" },
      }),
      router: { evaluate: async () => ({ advisorWouldHelp: 0.9, consequence: 4 }) },
    });

    const dispatch = primaryDispatch();
    await base.hookCallbacks.get("context")?.(dispatch);

    const delivered = dispatch.system.filter((part) => part.text.includes(ADVISOR_DELIVERY_PREFIX));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("advisor advice");
    expect(values.has(retainedReviewKey("ses_1" as never))).toBe(false);
    const event = [...values.values()].find(
      (value) => (value as { decision?: string }).decision === "accept",
    );
    expect(event).toMatchObject({ decision: "accept", delivered: true });
    expect(dispatch.messages).toHaveLength(1);
  });
});

describe("plugin session deletion and retained review cleanup", () => {
  test("session deletion removes the retained review", async () => {
    const h = await compositionHarness();
    await h.fire("context", primaryDispatch());
    expect(storedReview(h.values)).toBe("advisor advice");

    h.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await ticks();

    expect(storedReview(h.values)).toBeUndefined();
    await h.cleanup();
  });

  test("an in-flight retention write after session deletion does not persist", async () => {
    const gate = retainedWriteGate();
    const h = await compositionHarness({ writeGate: gate });
    const dispatch = primaryDispatch();
    const pending = h.fire("context", dispatch);
    await gate.started;

    h.push({ type: "session.deleted", data: { sessionID: "ses_1" } });
    await ticks();
    gate.release();
    await pending;

    expect(storedReview(h.values)).toBeUndefined();
    await h.cleanup();
  });

  test("cleanup invalidates a pending context review before earlier disposer awaits", async () => {
    const eligibility = gated();
    const disposer = gated();
    const h = await compositionHarness({
      sessionGet: async () => {
        eligibility.markStarted();
        await eligibility.promise;
        return { parentID: undefined, permissions: [] };
      },
      holdContextDisposer: disposer,
    });
    const dispatch = primaryDispatch();
    const firing = h.fire("context", dispatch);
    await eligibility.started;

    const cleaning = h.cleanup();
    await disposer.started;
    eligibility.release();
    await firing;

    expect(dispatch.system).toEqual([]);
    expect(dispatch.messages).toHaveLength(1);

    disposer.release();
    await cleaning;
    await h.cleanup();
    expect(h.base.disposers.filter((entry) => entry === "hook:context")).toHaveLength(1);
    expect(h.signals[0]?.aborted).toBe(true);
  });
});
