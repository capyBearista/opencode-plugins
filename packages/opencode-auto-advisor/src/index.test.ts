import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "./config.js";
import plugin, { ADVISOR_TOOL_DESCRIPTION, ADVISOR_TOOL_NAME, registerPlugin } from "./index.js";

type AddedTool = {
  name: string;
  description: string;
  input: {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: unknown;
  };
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

    expect(context.hooks).toEqual(["context"]);
    expect(context.hookCallbacks.get("context")).toBeFunction();

    expect(typeof cleanup).toBe("function");
    await cleanup?.();
    await cleanup?.();
    expect(context.disposers).toEqual(["hook:context", `tool:${ADVISOR_TOOL_NAME}`]);
  });

  test("package.json keeps a single package-root server export", async () => {
    const manifest = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    expect(manifest.files).toEqual(["dist", "server.js"]);
    expect(manifest.peerDependencies["@opencode/plugin"]).toBeString();
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
      tools: {},
    };
    await base.hookCallbacks.get("context")?.(dispatch);

    expect(dispatch.messages).toHaveLength(2);
    expect(dispatch.messages[1]?.role).toBe("system");
    expect(rpcIDs).toEqual(["experimental.auto-advisor"]);
    expect(values.has("head")).toBe(true);
    const stored = [...values.values()].find(
      (value) => (value as { decision?: string }).decision === "accept",
    );
    expect(stored).toMatchObject({ mode: "active", delivered: true });
    expect(signals).toHaveLength(1);

    await cleanup?.();
    expect(signals[0]?.aborted).toBe(true);
    expect(base.disposers).toEqual([
      "hook:context",
      "rpc:experimental.auto-advisor",
      `tool:${ADVISOR_TOOL_NAME}`,
    ]);
  });

  test("real V2 host resolves the package root server wrapper to the built entry", () => {
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

    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
      local: {
        server: pathToFileURL(join(packageRoot, "server.js")).href,
        tui: null,
        rpc: null,
      },
      named: {
        server: pathToFileURL(join(packageRoot, "dist", "index.js")).href,
        tui: null,
        rpc: null,
      },
    });
  });
});
