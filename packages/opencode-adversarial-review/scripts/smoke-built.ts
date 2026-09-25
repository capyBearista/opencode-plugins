type PluginDefinition = {
  readonly id: string;
  readonly setup: (context: unknown) => Promise<void> | void;
};

type ReviewModel = { providerID: string; id: string; variant?: string };

type SmokeSession = Record<string, unknown> & { id: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`);
}

const server = (await import(new URL("../server.js", import.meta.url).href)) as {
  default: PluginDefinition;
};

assert(server.default.id === "capybearista.opencode-adversarial-review", "server id mismatch");
assert(typeof server.default.setup === "function", "server setup is not a function");

const CALLER_MODEL: ReviewModel = {
  providerID: "smoke-provider",
  id: "smoke-model",
  variant: "smoke-variant",
};
const VALID_OUTPUT = '{"verdict":"approve","summary":"smoke","findings":[],"next_steps":[]}';

const agentIds: string[] = [];
const commandNames: string[] = [];
const created: SmokeSession[] = [];
const prompts: Array<Record<string, unknown>> = [];
const synthetics: Array<Record<string, unknown>> = [];
const sessionGets: string[] = [];
const hookEvents: Array<{ sessionID: string; options: { temperature?: number } }> = [];
const hooks: Array<(event: { sessionID: string; options: { temperature?: number } }) => void> = [];
let reviewerOutput = VALID_OUTPUT;
let definition: { name: string; execute: (invocation: unknown) => Promise<void> } | undefined;

await server.default.setup({
  options: {},
  location: { directory: process.cwd() },
  agent: {
    transform: async (callback: (editor: unknown) => void) => {
      callback({
        list: () => [],
        get: () => undefined,
        update: (id: string, update: (agent: Record<string, unknown>) => void) => {
          update({ id, permissions: [] });
          agentIds.push(id);
        },
        remove: () => {},
        default: () => {},
      });
      return { dispose: async () => {} };
    },
  },
  command: {
    transform: async (callback: (editor: unknown) => void) => {
      callback({
        add: (command: { name: string; execute: (invocation: unknown) => Promise<void> }) => {
          commandNames.push(command.name);
          definition = command;
        },
      });
      return { dispose: async () => {} };
    },
  },
  session: {
    hook: async (
      _name: string,
      callback: (event: { sessionID: string; options: { temperature?: number } }) => void,
    ) => {
      hooks.push(callback);
      return { dispose: async () => {} };
    },
    get: async ({ sessionID }: { sessionID: string }) => {
      sessionGets.push(sessionID);
      return { id: sessionID, model: CALLER_MODEL };
    },
    create: async (value: Record<string, unknown>) => {
      const session = { id: `ses_smoke_${created.length + 1}`, ...value };
      created.push(session);
      return session;
    },
    prompt: async (value: Record<string, unknown>) => {
      prompts.push(value);
      return {};
    },
    wait: async ({ sessionID }: { sessionID: string }) => {
      for (const hook of hooks) {
        const event = { sessionID, options: {} };
        hook(event);
        hookEvents.push(event);
      }
    },
    context: async () => [{ type: "assistant", content: [{ type: "text", text: reviewerOutput }] }],
    synthetic: async (value: Record<string, unknown>) => {
      synthetics.push(value);
      return {};
    },
  },
});

assert(agentIds.includes("adversarial-reviewer"), "reviewer agent was not registered");
assert(commandNames.includes("adversarial-review"), "review command was not registered");

const commandDefinition = definition;
assert(commandDefinition !== undefined, "review command definition was not captured");

const invoke = (text: string) =>
  commandDefinition.execute({
    sessionID: "ses_smoke_caller",
    prompt: { text },
    delivery: "steer",
  });

await invoke("smoke focus");

assert(created.length === 1, "review session was not created");
assert(
  JSON.stringify(created[0]?.model) === JSON.stringify(CALLER_MODEL),
  "inherited model was not passed to session.create",
);
assert(
  sessionGets.length === 1 && sessionGets[0] === "ses_smoke_caller",
  "invoking session model was not looked up",
);
assert(prompts.length === 1, "review prompt was not sent");
assert(synthetics.length === 1, "review output was not delivered");
assert(synthetics[0]?.text === VALID_OUTPUT, "valid review output was not forwarded verbatim");
assert(synthetics[0]?.metadata !== undefined, "review delivery metadata is missing");
assert(hookEvents.length === 2, "temperature hooks did not fire for the review session");
assert(
  hookEvents.every((event) => event.options.temperature === 0.1),
  "review temperature was not pinned",
);

reviewerOutput = '{"verdict":"approve"}';

let failure: unknown;
try {
  await invoke("invalid smoke");
  failure = undefined;
} catch (error) {
  failure = error;
}

assert(failure instanceof Error, "invalid review output did not throw");
assert(
  failure.message.includes("[schema-violation]"),
  "invalid review output did not throw a schema-violation",
);
assert(synthetics.length === 1, "invalid review output was still delivered");

process.stdout.write(
  "smoke: built server artifact loaded; model inheritance and strict validation verified\n",
);
