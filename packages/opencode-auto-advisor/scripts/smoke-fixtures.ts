export type Cleanup = () => Promise<void> | void;
export type RoutingMode = "off" | "observe" | "active";

export const ADVISOR_TOOL_NAME = "advisor";
export const TELEMETRY_RPC_ID = "experimental.auto-advisor";
export const REVIEW_RPC_ID = "experimental.auto-advisor.review";
export const ADVISOR_DELIVERY_PREFIX = "[Auto Advisor automatic advice]";
export const RETAINED_REVIEW_HEADER = "[Auto Advisor retained reviews]";
export const RETAINED_REVIEW_STORAGE_PREFIX = "auto-advisor:retained:";
export const SESSION_ID = "ses_smoke";
export const TURN_ONE = "msg-user-1";
export const TURN_TWO = "msg-user-2";
export const NEXT_TURN = "msg-user-3";
export const IN_FLIGHT_ASSISTANT = "msg-assistant-1";

export interface AddedTool {
  readonly name: string;
  readonly input: {
    readonly type: string;
    readonly properties: Record<string, unknown>;
    readonly additionalProperties: boolean;
  };
  readonly options?: { readonly codemode?: boolean; readonly permission?: string };
  readonly execute: (input: unknown, context: unknown) => Promise<{ readonly content?: string }>;
}

export interface RpcRegistration {
  readonly definition: { readonly id: string; readonly events?: Readonly<Record<string, unknown>> };
  readonly handlers: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
}

const CATALOG = [
  {
    id: "jev-1.13",
    providerID: "opencode",
    modelID: "jev-1.13",
    limit: { context: 200_000, output: 32_000 },
  },
];

const DURABLE_MESSAGES = [
  { id: TURN_ONE, type: "user", text: "explicit turn" },
  {
    id: IN_FLIGHT_ASSISTANT,
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    content: [{ type: "text", text: "assistant delta" }],
  },
];

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

export function createHost() {
  const host = {
    tools: [] as AddedTool[],
    hooks: [] as string[],
    hookCallbacks: new Map<string, (input: unknown) => Promise<void> | void>(),
    disposers: [] as string[],
    rpcRegistrations: new Map<string, RpcRegistration>(),
    signals: [] as AbortSignal[],
    values: new Map<string, unknown>(),
    prompts: [] as string[],
  };

  const disposable = (name: string) => ({ dispose: async () => host.disposers.push(name) });

  const ctx = {
    tool: {
      transform: async (callback: (editor: { add: (tool: AddedTool) => void }) => void) => {
        callback({ add: (tool) => host.tools.push(tool) });
        return disposable(`tool:${host.tools.at(-1)?.name ?? "unknown"}`);
      },
    },
    session: {
      hook: async (name: string, callback: (input: unknown) => Promise<void> | void) => {
        host.hooks.push(name);
        host.hookCallbacks.set(name, callback);
        return disposable(`hook:${name}`);
      },
      get: async () => ({ parentID: undefined, permissions: [] }),
      context: async () => DURABLE_MESSAGES,
    },
    agent: { get: async () => ({ data: { permissions: [] } }) },
    model: { list: async () => ({ data: CATALOG }) },
    storage: {
      get: async (key: string) => host.values.get(key),
      set: async (key: string, value: unknown) => host.values.set(key, value),
      remove: async (key: string) => host.values.delete(key),
    },
    rpc: {
      register: async (
        definition: RpcRegistration["definition"],
        handlers: RpcRegistration["handlers"],
      ) => {
        host.rpcRegistrations.set(definition.id, { definition, handlers });
        return {
          ...disposable(`rpc:${definition.id}`),
          events: { emit: async () => undefined },
        };
      },
    },
    event: {
      subscribe: (options: { readonly signal?: AbortSignal }) => {
        if (options.signal) host.signals.push(options.signal);
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true, value: undefined }),
          }),
        };
      },
    },
    generate: {
      text: async (input: { readonly prompt: string }) => {
        host.prompts.push(input.prompt);
        return { text: "smoke advice" };
      },
    },
  };

  return Object.assign(host, { ctx });
}

export type Host = ReturnType<typeof createHost>;

export function dispatch(id: string, text: string) {
  return {
    sessionID: SESSION_ID,
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [{ type: "text", text: "host system prompt" }],
    messages: [{ id, role: "user", content: [{ type: "text", text }] }],
    options: {},
    tools: { [ADVISOR_TOOL_NAME]: { description: "advisor", input: { type: "object" } } },
    kind: "primary",
  };
}

export function acceptingRouter() {
  return { evaluate: async () => ({ advisorWouldHelp: 0.9, consequence: 4 }) };
}

export function smokeConfig(mode: RoutingMode) {
  return {
    advisor: { timeoutMs: 300_000 },
    routing: {
      mode,
      models: ["jev-1.13"],
      advisorWouldHelpThreshold: 0.7,
      consequenceThreshold: 3,
      maxConsultationsPerTurn: 1,
    },
  };
}

export function toolContext(): Record<string, unknown> {
  return { sessionID: SESSION_ID, messageID: IN_FLIGHT_ASSISTANT, agent: "build" };
}

export function fire(host: Host, name: string, input: unknown): Promise<void> | void {
  const callback = host.hookCallbacks.get(name);
  if (callback === undefined) throw new Error(`smoke: hook ${name} was not registered`);
  return callback(input);
}
