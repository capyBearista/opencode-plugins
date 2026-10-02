import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_DELIVERY_PREFIX,
  ADVISOR_TOOL_NAME,
  acceptingRouter,
  assert,
  type Cleanup,
  createHost,
  dispatch,
  fire,
  NEXT_TURN,
  RETAINED_REVIEW_HEADER,
  RETAINED_REVIEW_STORAGE_PREFIX,
  REVIEW_RPC_ID,
  SESSION_ID,
  smokeConfig,
  TELEMETRY_RPC_ID,
  TURN_ONE,
  TURN_TWO,
  toolContext,
} from "./smoke-fixtures.js";

interface PluginModule {
  readonly default: { readonly id: string; readonly setup: (context: unknown) => unknown };
  readonly registerPlugin: (context: unknown, options: unknown) => Promise<Cleanup>;
}

interface ReviewStatus {
  readonly running?: readonly unknown[];
  readonly lastFinished?: { readonly outcome?: string };
  readonly latest?: { readonly advice?: string };
}

const server = (await import(
  new URL("../server.js", import.meta.url).href
)) as unknown as PluginModule;
const tui = (await import(new URL("../tui.js", import.meta.url).href)) as unknown as {
  readonly default: { readonly id: string; readonly setup: (context: unknown) => unknown };
};

assert(server.default.id === "capybearista.opencode-auto-advisor", "server plugin id mismatch");
assert(typeof server.default.setup === "function", "server plugin setup missing");
assert(tui.default.id === "capybearista.opencode-auto-advisor-tui", "tui plugin id mismatch");
assert(typeof tui.default.setup === "function", "tui plugin setup missing");

const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = join(tmpdir(), `auto-advisor-smoke-${process.pid}`);
try {
  const host = createHost();
  const config = smokeConfig("off");
  const cleanup = await server.registerPlugin(host.ctx, {
    loadConfig: async () => config,
    router: acceptingRouter(),
  });

  assert(host.tools.length === 1, `expected one tool, saw ${host.tools.length}`);
  const tool = host.tools[0];
  assert(tool !== undefined, "advisor tool missing");
  assert(tool.name === ADVISOR_TOOL_NAME, `advisor tool name mismatch: ${tool.name}`);
  assert(tool.input.type === "object", "advisor tool input must be an object schema");
  assert(Object.keys(tool.input.properties).length === 0, "advisor tool must take no arguments");
  assert(tool.input.additionalProperties === false, "advisor tool must reject extra arguments");
  assert(tool.options?.codemode === false, "advisor tool must disable codemode");
  assert(
    tool.options?.permission === ADVISOR_TOOL_NAME,
    "advisor tool must declare its permission",
  );

  assert(host.hooks.join(",") === "context", `hook registration mismatch: ${host.hooks.join(",")}`);
  assert(host.signals.length === 1, "session.deleted subscription missing");

  const review = host.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(review !== undefined, "review rpc missing");
  assert(host.rpcRegistrations.has(TELEMETRY_RPC_ID), "telemetry rpc missing");
  const statusHandler = review.handlers.status;
  assert(statusHandler !== undefined, "review status handler missing");
  assert(
    Object.keys(review.definition.events ?? {}).join(",") === "review.started,review.finished",
    "review rpc event contract mismatch",
  );

  await fire(host, "context", dispatch(TURN_ONE, "explicit turn"));
  const explicit = await tool.execute({}, toolContext());
  assert(explicit.content === "smoke advice", `explicit consult failed: ${explicit.content}`);
  const explicitPrompts = host.prompts.length;
  assert(explicitPrompts === 1, `explicit consult generated ${explicitPrompts} times`);

  config.routing.mode = "active";
  const autoDispatch = dispatch(TURN_TWO, "automatic turn");
  await fire(host, "context", autoDispatch);
  const automaticPrompts = host.prompts.length;
  assert(automaticPrompts === 2, `automatic consult generated ${automaticPrompts} times`);
  const advice = autoDispatch.system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX));
  assert(advice.length === 1, "automatic advice must reach the system context exactly once");
  assert(
    advice[0]?.text?.includes("smoke advice") === true,
    "system advice must carry the advice text",
  );
  assert(
    autoDispatch.messages.length === 1 &&
      autoDispatch.messages.every((message) => message.role === "user"),
    "automatic advice must not create conversation messages",
  );

  const retainedKey = `${RETAINED_REVIEW_STORAGE_PREFIX}${SESSION_ID}`;
  const stored = host.values.get(retainedKey) as { advice?: string; turnKey?: string } | undefined;
  assert(
    stored?.advice === "smoke advice" && stored.turnKey === TURN_TWO,
    `retained write mismatch: ${JSON.stringify(stored)}`,
  );

  const retainedDispatch = dispatch(NEXT_TURN, "retained read turn");
  await fire(host, "context", retainedDispatch);
  const retained = retainedDispatch.system.filter((part) =>
    part.text?.includes(RETAINED_REVIEW_HEADER),
  );
  assert(retained.length === 1, "retained review must be injected exactly once");
  assert(
    retained[0]?.text?.includes("smoke advice") === true,
    "retained review must carry the stored advice",
  );

  const status = (await statusHandler({ sessionID: SESSION_ID })) as ReviewStatus;
  assert(status.latest?.advice === "smoke advice", "review status must publish the latest advice");
  assert(status.lastFinished?.outcome === "completed", "review status must finish completed");
  assert(status.running?.length === 0, "review status must clear running");

  await cleanup();
  await cleanup();
  assert(host.signals[0]?.aborted === true, "cleanup must abort the session.deleted subscription");
  const expectedDisposers = [
    "hook:context",
    `rpc:${REVIEW_RPC_ID}`,
    `rpc:${TELEMETRY_RPC_ID}`,
    `tool:${ADVISOR_TOOL_NAME}`,
  ];
  assert(
    JSON.stringify(host.disposers) === JSON.stringify(expectedDisposers),
    `cleanup order mismatch: ${JSON.stringify(host.disposers)}`,
  );
  const rpcDisposals = host.disposers.filter((name) => name.startsWith("rpc:"));
  assert(rpcDisposals.length === 2, "rpc cleanup must dispose each registration exactly once");

  process.stdout.write(
    "smoke: built entries, tool schema, hook, consults, retained review, rpc, cleanup ok\n",
  );
} finally {
  if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory;
}
