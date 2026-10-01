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

type Dispatch = {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { providerID: string; id: string };
  readonly system: Array<{ type: string; text: string }>;
  readonly messages: Array<{
    id?: string;
    role: string;
    content: Array<{ type: string; text: string }>;
  }>;
  readonly options: Record<string, unknown>;
  readonly tools: Record<string, unknown>;
};

function dispatch(extra: Record<string, unknown> = {}): Dispatch {
  return {
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
  } as Dispatch;
}

const server = (await import(new URL("../server.js", import.meta.url).href)) as {
  default: {
    id: string;
    setup: (context: unknown) => Promise<Cleanup | undefined> | Cleanup | undefined;
  };
  registerPlugin: (
    context: unknown,
    options?: { router?: unknown },
  ) => Promise<Cleanup | undefined>;
};

assert(server.default.id === "capybearista.opencode-auto-advisor", "server id mismatch");
assert(typeof server.default.setup === "function", "server setup is not a function");
assert(typeof server.registerPlugin === "function", "server registerPlugin is not exported");

const configDirectory = await mkdtemp(join(tmpdir(), "auto-advisor-smoke-"));
const configPath = join(configDirectory, "auto-advisor.json");
const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = configDirectory;

function createMockContext() {
  const added: AddedTool[] = [];
  const disposers: string[] = [];
  const hookNames: string[] = [];
  const hookCallbacks = new Map<string, HookCallback>();
  const prompts: Array<{ prompt: string; model?: { providerID: string; id: string } }> = [];
  const contextReads: string[] = [];
  const rpcIDs: string[] = [];
  const signals: AbortSignal[] = [];
  const values = new Map<string, unknown>();

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
      hook: async (name: string, callback: HookCallback) => {
        hookNames.push(name);
        hookCallbacks.set(name, callback);
        return {
          dispose: async () => {
            disposers.push(`hook:${name}`);
          },
        };
      },
      context: async (input: { sessionID: string }) => {
        contextReads.push(input.sessionID);
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
            disposers.push(`rpc:${definition.id}`);
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

  return {
    ctx,
    added,
    disposers,
    hookNames,
    hookCallbacks,
    prompts,
    contextReads,
    rpcIDs,
    signals,
    values,
  };
}

const fire = async (context: ReturnType<typeof createMockContext>, input: unknown) => {
  const hook = context.hookCallbacks.get("context");
  assert(hook !== undefined, "the context hook callback was not registered");
  await hook(input as Record<string, unknown>);
};

const defaultMock = createMockContext();
const defaultCleanup = await server.default.setup(defaultMock.ctx);

assert(
  defaultMock.hookNames.length === 1 && defaultMock.hookNames[0] === "context",
  "setup did not register exactly one context hook",
);
assert(defaultMock.added.length === 1, "setup did not register exactly one tool");
const tool = defaultMock.added[0];
assert(tool !== undefined && tool.name === "advisor", "the advisor tool was not registered");
assert(tool.input.type === "object", "the advisor tool input is not an object schema");
assert(
  Object.keys(tool.input.properties).length === 0 && tool.input.additionalProperties === false,
  "the advisor tool must take no arguments",
);
assert(tool.description.length > 0, "the advisor tool description is empty");
assert(defaultMock.rpcIDs.length === 1, "setup did not register the telemetry rpc");

const offDispatch = dispatch({ kind: "primary" });
const offBefore = JSON.stringify(offDispatch);
await fire(defaultMock, offDispatch);
assert(defaultMock.contextReads.length === 0, "off mode read the session context");
assert(defaultMock.prompts.length === 0, "off mode generated text");
assert(JSON.stringify(offDispatch) === offBefore, "off mode mutated the dispatch");

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
assert(defaultMock.prompts.length === 1, "the advisor tool did not generate exactly once");
assert(
  defaultMock.prompts[0]?.model?.providerID === "opencode" &&
    defaultMock.prompts[0]?.model?.id === "jev-1.13",
  "the advisor did not inherit the executor model",
);
const advisorPrompt = defaultMock.prompts[0]?.prompt ?? "";
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

await defaultCleanup?.();
assert(
  JSON.stringify(defaultMock.disposers) ===
    JSON.stringify(["hook:context", "rpc:experimental.auto-advisor", "tool:advisor"]),
  "cleanup did not dispose the hook, rpc, and tool registrations",
);

const stubRouter = {
  evaluate: async () => ({
    advisorWouldHelp: 0.9,
    consequence: 4,
    metadata: { model: "jev-1.13-free", attempts: 1 },
  }),
};
const modeMock = createMockContext();
const modeCleanup = await server.registerPlugin(modeMock.ctx, { router: stubRouter });

const turn = (id: string, text: string) =>
  dispatch({
    kind: "primary",
    messages: [{ id, role: "user", content: [{ type: "text", text }] }],
  });

await writeFile(configPath, JSON.stringify({ routing: { mode: "off" } }));
await fire(modeMock, turn("msg-off", "off prompt"));
assert(modeMock.values.size === 0, "off mode recorded telemetry");

await writeFile(configPath, JSON.stringify({ routing: { mode: "observe" } }));
const observeDispatch = turn("msg-observe", "observe prompt");
const observeBefore = JSON.stringify(observeDispatch);
await fire(modeMock, observeDispatch);
assert(modeMock.prompts.length === 0, "observe mode invoked the advisor");
assert(JSON.stringify(observeDispatch) === observeBefore, "observe mode mutated the dispatch");
assert(modeMock.values.has("head"), "observe mode did not persist telemetry");

await writeFile(configPath, JSON.stringify({ routing: { mode: "active" } }));
const activeDispatch = turn("msg-active", "active prompt");
await fire(modeMock, activeDispatch);
assert(modeMock.prompts.length === 1, "active mode did not consult the advisor");
assert(activeDispatch.messages.length === 2, "active mode did not inject the advice");
const injected = activeDispatch.messages[1];
assert(injected?.role === "system", "active mode did not inject a system-role message");
assert(
  injected?.content.some((part) => part.text.startsWith("[Auto Advisor automatic advice]")) ===
    true,
  "injected advice is missing the advisor prefix",
);
await fire(modeMock, dispatch({ kind: "compaction" }));
assert(modeMock.prompts.length === 1, "active mode evaluated an auxiliary dispatch");

const stored = [...modeMock.values.values()]
  .filter((value) => (value as { decision?: string }).decision === "accept")
  .at(-1);
assert(stored !== undefined, "active mode did not record telemetry");
assert((stored as { delivered?: boolean }).delivered === true, "telemetry missed the delivery");
assert(
  (stored as { advisorContext?: { complete?: boolean } }).advisorContext?.complete === true,
  "active telemetry missed the advisor context diagnostics",
);
assert(
  (stored as { advisorContext?: { inputBudget?: number } }).advisorContext?.inputBudget === 150_000,
  "the advisor input budget did not honor the model limits",
);
assert(modeMock.signals.length === 1, "session.deleted cleanup did not subscribe");

await modeCleanup?.();
assert(modeMock.signals[0]?.aborted === true, "cleanup did not abort the event subscription");
assert(
  JSON.stringify(modeMock.disposers) ===
    JSON.stringify(["hook:context", "rpc:experimental.auto-advisor", "tool:advisor"]),
  "mode cleanup did not dispose the hook, rpc, and tool registrations",
);

if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory;
await rm(configDirectory, { recursive: true, force: true });

process.stdout.write(
  "smoke: built server.js registered the advisor tool, one context hook, and the read-only telemetry rpc; off stayed inert, observe persisted digest-only telemetry without consulting, active consulted and injected system-role advice into the dispatch, and cleanup disposed every registration\n",
);
