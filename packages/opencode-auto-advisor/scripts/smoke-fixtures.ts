export type Cleanup = () => Promise<void> | void;

export const ADVISOR_TOOL_NAME = "advisor";
export const TELEMETRY_RPC_ID = "experimental.auto-advisor";
export const REVIEW_RPC_ID = "experimental.auto-advisor.review";
export const ADVICE_HISTORY_STORAGE_KEY = "advice-history:v1";
export const ADVISOR_DELIVERY_PREFIX = "[Auto Advisor automatic advice]";
export const RETAINED_REVIEWS_MARKER = "[Auto Advisor retained reviews]";
export const COMPACTION_BLOCK_START = "[AUTO_ADVISOR_RETAINED_REVIEWS_V1]";
export const COMPACTION_BLOCK_END = "[/AUTO_ADVISOR_RETAINED_REVIEWS_V1]";
export const EXECUTOR_GUIDANCE_NEEDLE = "zero-argument advisor() tool";
export const SESSION_ID = "ses_smoke";
export const TURN_ONE = "msg-user-1";
export const TURN_TWO = "msg-user-2";
export const IN_FLIGHT_ASSISTANT = "msg-assistant-1";

export interface ModelEntry {
  readonly id: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly limit: { readonly context: number; readonly output: number; readonly input?: number };
}

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface AddedTool {
  readonly name: string;
  readonly description: string;
  readonly input: {
    readonly type: string;
    readonly properties: Record<string, unknown>;
    readonly additionalProperties: boolean;
    readonly required?: unknown;
  };
  readonly options?: { readonly codemode?: boolean; readonly permission?: string };
  readonly execute: (
    input: unknown,
    context: unknown,
  ) => Promise<{ readonly content?: string; readonly metadata?: Record<string, unknown> }>;
}

export interface GenerateInput {
  readonly prompt: string;
  readonly model?: { readonly providerID: string; readonly id: string };
}

export type RpcHandler = (input: unknown) => Promise<unknown>;

export interface RpcDefinition {
  readonly id: string;
  readonly methods?: Readonly<Record<string, unknown>>;
  readonly events?: Readonly<Record<string, unknown>>;
}

export interface RpcRegistration {
  readonly id: string;
  readonly definition: RpcDefinition;
  readonly handlers: Readonly<Record<string, RpcHandler>>;
  readonly emitted: Array<readonly [string, unknown]>;
  disposed: number;
}

export interface Dispatch {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly system: Array<{ readonly type?: string; readonly text?: string }>;
  readonly messages: Array<{
    readonly id?: string;
    readonly role?: string;
    readonly content?: Array<{ readonly type?: string; readonly text?: string }>;
  }>;
  readonly options: Record<string, unknown>;
  readonly tools: Record<string, unknown>;
  readonly kind?: string;
  readonly [key: string]: unknown;
}

export interface CompactionEvent {
  readonly sessionID: string;
  readonly agent: string;
  readonly system: Array<{ readonly type?: string; readonly text?: string }>;
  readonly result: { readonly summary?: string };
  readonly [key: string]: unknown;
}

export interface RouterStub {
  readonly evaluated: unknown[];
  readonly evaluate: (state: unknown) => Promise<{ advisorWouldHelp: number; consequence: number }>;
}

export interface SmokeConfig {
  readonly advisor: {
    readonly timeoutMs: number;
    readonly model?: { readonly providerID: string; readonly id: string };
  };
  readonly routing: {
    mode: "off" | "observe" | "active";
    readonly models: readonly string[];
    readonly advisorWouldHelpThreshold: number;
    readonly consequenceThreshold: number;
    readonly maxConsultationsPerTurn: number;
  };
}

export interface HeldGeneration {
  readonly started: Promise<void>;
  readonly text: (input: GenerateInput) => Promise<{ readonly text: string }>;
  readonly resolve: (text: string) => void;
  readonly reject: (cause: unknown) => void;
}

export interface Host {
  readonly ctx: Record<string, unknown>;
  readonly tools: AddedTool[];
  readonly disposers: string[];
  readonly hooks: string[];
  readonly hookCallbacks: Map<string, (input: unknown) => Promise<void> | void>;
  readonly rpcRegistrations: Map<string, RpcRegistration>;
  readonly signals: AbortSignal[];
  readonly values: Map<string, unknown>;
  readonly prompts: GenerateInput[];
  readonly contextReads: string[];
  readonly events: { readonly push: (payload: unknown) => void };
}

export interface HostOptions {
  readonly generate?: (input: GenerateInput) => Promise<{ readonly text: string }>;
  readonly catalog?: readonly ModelEntry[];
  readonly messages?: readonly Record<string, unknown>[];
  readonly sessionGet?: (input: {
    readonly sessionID: string;
  }) => Promise<
    { readonly parentID?: string; readonly permissions?: readonly PermissionRule[] } | undefined
  >;
  readonly agentGet?: (input: {
    readonly agentID: string;
  }) => Promise<
    { readonly data?: { readonly permissions?: readonly PermissionRule[] } } | undefined
  >;
  failAdviceWrites?: boolean;
}

export const DEFAULT_CATALOG: readonly ModelEntry[] = [
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
];

export const DURABLE_MESSAGES: readonly Record<string, unknown>[] = [
  { id: TURN_ONE, time: { created: 1 }, type: "user", text: "hook-only user message" },
  {
    id: IN_FLIGHT_ASSISTANT,
    time: { created: 2, completed: 3 },
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.14" },
    content: [
      { type: "text", text: "durable assistant delta" },
      { type: "reasoning", text: "SECRET_REASONING_NONCE" },
      {
        type: "tool",
        id: "call_evidence",
        name: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/*.ts" },
          content: [{ type: "text", text: "TOOL_EVIDENCE_NONCE" }],
        },
        time: { created: 2 },
      },
    ],
  },
];

export const SIMPLE_DURABLE_MESSAGES: readonly Record<string, unknown>[] = [
  { id: TURN_ONE, time: { created: 1 }, type: "user", text: "hook-only user message" },
  {
    id: IN_FLIGHT_ASSISTANT,
    time: { created: 2, completed: 3 },
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    content: [{ type: "text", text: "persisted assistant delta" }],
  },
];

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

export function createHost(options: HostOptions = {}): Host {
  const tools: AddedTool[] = [];
  const disposers: string[] = [];
  const hooks: string[] = [];
  const hookCallbacks = new Map<string, (input: unknown) => Promise<void> | void>();
  const rpcRegistrations = new Map<string, RpcRegistration>();
  const signals: AbortSignal[] = [];
  const values = new Map<string, unknown>();
  const prompts: GenerateInput[] = [];
  const contextReads: string[] = [];
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  const push = (payload: unknown): void => {
    queue.push(payload);
    wake?.();
    wake = undefined;
  };

  const generate = async (input: GenerateInput): Promise<{ readonly text: string }> => {
    prompts.push(input);
    return options.generate ? options.generate(input) : { text: "smoke advice" };
  };

  const ctx = {
    tool: {
      transform: async (callback: (editor: { add: (tool: AddedTool) => void }) => void) => {
        callback({
          add: (tool) => {
            tools.push(tool);
          },
        });
        return {
          dispose: async () => {
            disposers.push(`tool:${tools.at(-1)?.name ?? "unknown"}`);
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
      get: options.sessionGet ?? (async () => ({ parentID: undefined, permissions: [] })),
      context: async (input: { readonly sessionID: string }) => {
        contextReads.push(input.sessionID);
        return options.messages ?? DURABLE_MESSAGES;
      },
    },
    agent: { get: options.agentGet ?? (async () => ({ data: { permissions: [] } })) },
    model: { list: async () => ({ data: options.catalog ?? DEFAULT_CATALOG }) },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        if (options.failAdviceWrites && key === ADVICE_HISTORY_STORAGE_KEY) {
          throw new Error("smoke: advice storage write failed");
        }
        values.set(key, value);
      },
      remove: async (key: string) => {
        values.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    rpc: {
      register: async (
        definition: RpcDefinition,
        handlers: Readonly<Record<string, RpcHandler>>,
      ) => {
        const registration: RpcRegistration = {
          id: definition.id,
          definition,
          handlers,
          emitted: [],
          disposed: 0,
        };
        rpcRegistrations.set(definition.id, registration);
        return {
          dispose: async () => {
            registration.disposed += 1;
            disposers.push(`rpc:${definition.id}`);
          },
          events: {
            emit: async (name: string, snapshot: unknown) => {
              registration.emitted.push([name, snapshot]);
            },
          },
        };
      },
    },
    event: {
      subscribe: (subscribeOptions: { readonly signal?: AbortSignal }) => {
        if (subscribeOptions.signal) signals.push(subscribeOptions.signal);
        return (async function* () {
          while (!closed) {
            if (queue.length === 0) {
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
            while (queue.length > 0) yield queue.shift();
          }
        })();
      },
    },
    generate: { text: generate },
  };

  return {
    ctx,
    tools,
    disposers,
    hooks,
    hookCallbacks,
    rpcRegistrations,
    signals,
    values,
    prompts,
    contextReads,
    events: { push },
  };
}

export function dispatch(extra: Record<string, unknown> = {}): Dispatch {
  return {
    sessionID: SESSION_ID,
    agent: "build",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [{ type: "text", text: "hook-only system mutation" }],
    messages: [
      {
        id: TURN_ONE,
        role: "user",
        content: [{ type: "text", text: "hook-only user message" }],
      },
    ],
    options: {},
    tools: { [ADVISOR_TOOL_NAME]: { description: "advisor", input: { type: "object" } } },
    ...extra,
  } as Dispatch;
}

export function turn(id: string, text: string, extra: Record<string, unknown> = {}): Dispatch {
  return dispatch({
    kind: "primary",
    messages: [{ id, role: "user", content: [{ type: "text", text }] }],
    ...extra,
  });
}

export function compactionEvent(extra: Record<string, unknown> = {}): CompactionEvent {
  return {
    sessionID: SESSION_ID,
    agent: "build",
    system: [],
    result: { summary: "" },
    ...extra,
  } as CompactionEvent;
}

export function heldGeneration(): HeldGeneration {
  let settle: (value: { readonly text: string }) => void = () => undefined;
  let fail: (cause: unknown) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    text: () => {
      markStarted();
      return new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    },
    resolve: (text) => settle({ text }),
    reject: (cause) => fail(cause),
  };
}

export function acceptingRouter(): RouterStub {
  const evaluated: unknown[] = [];
  return {
    evaluated,
    evaluate: async (state) => {
      evaluated.push(state);
      return { advisorWouldHelp: 0.9, consequence: 4 };
    },
  };
}

export function smokeConfig(
  mode: SmokeConfig["routing"]["mode"],
  extra: {
    readonly timeoutMs?: number;
    readonly advisorModel?: { readonly providerID: string; readonly id: string };
  } = {},
): SmokeConfig {
  return {
    advisor: {
      timeoutMs: extra.timeoutMs ?? 300_000,
      ...(extra.advisorModel ? { model: extra.advisorModel } : {}),
    },
    routing: {
      mode,
      models: ["jev-1.13-free", "jev-1.13"],
      advisorWouldHelpThreshold: 0.7,
      consequenceThreshold: 3,
      maxConsultationsPerTurn: 1,
    },
  };
}

export function toolContext(): Record<string, unknown> {
  return { sessionID: SESSION_ID, messageID: IN_FLIGHT_ASSISTANT, agent: "build" };
}

export function fire(
  host: Host,
  name: string,
  input: Record<string, unknown>,
): Promise<void> | void {
  const callback = host.hookCallbacks.get(name);
  if (callback === undefined) throw new Error(`smoke: hook ${name} was not registered`);
  return callback(input);
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function ticks(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await tick();
}

export function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

export function telemetryEvents(host: Host): Array<Record<string, unknown>> {
  return [...host.values.entries()]
    .filter(([key]) => key.startsWith("evt:"))
    .map(([, value]) => value as Record<string, unknown>);
}

export function adviceRecords(host: Host, sessionID: string): Array<Record<string, unknown>> {
  const state = host.values.get(ADVICE_HISTORY_STORAGE_KEY) as
    | {
        readonly sessions?: readonly {
          readonly sessionID: string;
          readonly records?: readonly Record<string, unknown>[];
        }[];
      }
    | undefined;
  return (
    [...(state?.sessions ?? [])].find((entry) => entry.sessionID === sessionID)?.records ?? []
  ).slice();
}
