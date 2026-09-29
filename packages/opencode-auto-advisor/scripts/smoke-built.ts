import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cleanup = () => Promise<void> | void;

type AddedTool = {
  name: string;
  description: string;
  input: { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
  execute: (
    input: unknown,
    context: unknown,
  ) => Promise<{ content?: string; metadata?: Record<string, unknown> }>;
};

type HookCallback = (input: Record<string, unknown>) => Promise<void> | void;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function dispatch(extra: Record<string, unknown> = {}) {
  return deepFreeze({
    sessionID: "ses_smoke",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [{ type: "text", text: "smoke hook system" }],
    messages: [
      {
        id: "msg-user",
        role: "user",
        content: [{ type: "text", text: "smoke prompt" }],
      },
    ],
    options: {},
    tools: {},
    ...extra,
  });
}

const server = (await import(new URL("../server.js", import.meta.url).href)) as {
  default: {
    id: string;
    setup: (context: unknown) => Promise<Cleanup | undefined> | Cleanup | undefined;
  };
};

assert(server.default.id === "capybearista.opencode-auto-advisor", "server id mismatch");
assert(typeof server.default.setup === "function", "server setup is not a function");

const configDirectory = await mkdtemp(join(tmpdir(), "auto-advisor-smoke-"));
const configPath = join(configDirectory, "auto-advisor.json");
const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = configDirectory;

const added: AddedTool[] = [];
const disposers: string[] = [];
const hookNames: string[] = [];
const hookCallbacks = new Map<string, HookCallback>();
const prompts: Array<{ prompt: string; model?: { providerID: string; id: string } }> = [];
let contextReads = 0;

const cleanup = await server.default.setup({
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
    hook: async (name: string, callback: HookCallback) => {
      hookNames.push(name);
      hookCallbacks.set(name, callback);
      return {
        dispose: async () => {
          disposers.push(`hook:${name}`);
        },
      };
    },
    context: async () => {
      contextReads += 1;
      return [
        { id: "msg-user", time: { created: 1 }, type: "user", text: "smoke prompt" },
        {
          id: "msg-smoke",
          time: { created: 2 },
          type: "assistant",
          agent: "build",
          model: { providerID: "opencode", id: "jev-1.13" },
          content: [
            { type: "text", text: "smoke context" },
            {
              type: "tool",
              id: "call_advisor",
              name: "advisor",
              state: { status: "running", input: {}, metadata: {} },
              time: { created: 2 },
            },
          ],
        },
      ];
    },
  },
  generate: {
    text: async (input: { prompt: string; model?: { providerID: string; id: string } }) => {
      prompts.push(input);
      return { text: "smoke advice" };
    },
  },
});

assert(
  hookNames.length === 1 && hookNames[0] === "context",
  "setup did not register exactly one context hook",
);
const hook = hookCallbacks.get("context");
assert(hook !== undefined, "the context hook callback was not registered");

const fire = async (input: ReturnType<typeof dispatch>) => {
  await hook(input);
};

await fire(dispatch({ kind: "primary" }));
assert(contextReads === 0, "off mode read the session context");
assert(prompts.length === 0, "off mode generated text");

await writeFile(configPath, JSON.stringify({ routing: { mode: "observe" } }));
await fire(dispatch({ kind: "primary" }));
assert(contextReads === 0, "observe mode read persisted history instead of the hook request");
assert(prompts.length === 0, "observe mode invoked the advisor");
await fire(dispatch({ kind: "compaction" }));
assert(contextReads === 0, "observe mode evaluated an auxiliary dispatch");

await writeFile(configPath, JSON.stringify({ routing: { mode: "active" } }));
await fire(dispatch({ kind: "primary" }));
assert(prompts.length === 0, "active mode generated without a configured router");

assert(added.length === 1, "setup did not register exactly one tool");
const tool = added[0];
assert(tool !== undefined && tool.name === "advisor", "the advisor tool was not registered");
assert(tool.input.type === "object", "the advisor tool input is not an object schema");
assert(
  Object.keys(tool.input.properties).length === 0 && tool.input.additionalProperties === false,
  "the advisor tool must take no arguments",
);
assert(tool.description.length > 0, "the advisor tool description is empty");

const result = await tool.execute(
  {},
  {
    sessionID: "ses_smoke",
    messageID: "msg-smoke",
    agent: "build",
    id: "call_advisor",
    signal: undefined,
  },
);
assert(result.content === "smoke advice", "the advisor tool did not return generated advice");
assert(prompts.length === 1, "the advisor tool did not generate exactly once");
assert(
  prompts[0]?.model?.providerID === "opencode" && prompts[0]?.model?.id === "jev-1.13",
  "the advisor did not inherit the executor model",
);
const advisorPrompt = prompts[0]?.prompt ?? "";
const occurrences = (value: string, needle: string) => value.split(needle).length - 1;
assert(
  occurrences(advisorPrompt, "smoke hook system") === 1,
  "the advisor prompt did not include the hook-time system mutation exactly once",
);
assert(
  occurrences(advisorPrompt, "smoke prompt") === 1,
  "the advisor prompt did not include the captured request user message exactly once",
);
assert(
  occurrences(advisorPrompt, "smoke context") === 1,
  "the advisor prompt did not include the current assistant delta exactly once",
);

assert(typeof cleanup === "function", "setup did not return a cleanup function");
await cleanup();
assert(
  JSON.stringify(disposers) === JSON.stringify(["hook:context", "tool:advisor"]),
  "cleanup did not dispose the hook and tool registrations",
);

if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory;
await rm(configDirectory, { recursive: true, force: true });

process.stdout.write(
  "smoke: built server.js registered the advisor tool and one context hook; routing read the assembled hook request without touching persisted history; the explicit consultation merged the hook snapshot with the current assistant delta exactly once in every mode; cleanup disposed both registrations\n",
);
