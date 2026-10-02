import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADVISOR_DELIVERY_PREFIX,
  ADVISOR_TOOL_NAME,
  acceptingRouter,
  adviceRecords,
  assert,
  type Cleanup,
  COMPACTION_BLOCK_END,
  COMPACTION_BLOCK_START,
  compactionEvent,
  createHost,
  DURABLE_MESSAGES,
  dispatch,
  EXECUTOR_GUIDANCE_NEEDLE,
  fire,
  type Host,
  type HostOptions,
  heldGeneration,
  IN_FLIGHT_ASSISTANT,
  occurrences,
  RETAINED_REVIEWS_MARKER,
  REVIEW_RPC_ID,
  type RouterStub,
  SESSION_ID,
  SIMPLE_DURABLE_MESSAGES,
  type SmokeConfig,
  smokeConfig,
  TELEMETRY_RPC_ID,
  TURN_ONE,
  TURN_TWO,
  telemetryEvents,
  tick,
  ticks,
  toolContext,
  turn,
} from "./smoke-fixtures.js";

interface PluginModule {
  readonly default: {
    readonly id: string;
    readonly setup: (context: unknown) => Promise<Cleanup> | Cleanup;
    readonly [key: string]: unknown;
  };
  readonly registerPlugin: (
    context: unknown,
    options?: { readonly loadConfig?: () => Promise<unknown>; readonly router?: unknown },
  ) => Promise<Cleanup>;
}

interface ReviewSnapshot {
  readonly sessionID?: unknown;
  readonly epoch?: unknown;
  readonly revision?: unknown;
  readonly running: Array<{ readonly id?: unknown; readonly startedAt?: unknown }>;
  readonly lastFinished?: {
    readonly id?: unknown;
    readonly startedAt?: unknown;
    readonly finishedAt?: unknown;
    readonly outcome?: string;
  };
  readonly latest?: {
    readonly id?: unknown;
    readonly finishedAt?: unknown;
    readonly advice?: string;
  };
}

const REVIEW_STATUS_KEYS = new Set([
  "sessionID",
  "epoch",
  "revision",
  "running",
  "lastFinished",
  "latest",
]);
const RUN_KEYS = new Set(["id", "startedAt"]);
const FINISHED_KEYS = new Set(["id", "startedAt", "finishedAt", "outcome"]);
const LATEST_KEYS = new Set(["id", "finishedAt", "advice"]);

function assertKeys(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value as Record<string, unknown>)) {
    assert(allowed.has(key), `${label}: undeclared key ${key}`);
  }
}

function assertReviewSnapshot(value: unknown, label: string): void {
  const snapshot = value as Record<string, unknown>;
  assertKeys(snapshot, REVIEW_STATUS_KEYS, label);
  for (const run of (snapshot.running as readonly unknown[] | undefined) ?? []) {
    assertKeys(run, RUN_KEYS, `${label}.running`);
  }
  if (snapshot.lastFinished !== undefined) {
    assertKeys(snapshot.lastFinished, FINISHED_KEYS, `${label}.lastFinished`);
  }
  if (snapshot.latest !== undefined) assertKeys(snapshot.latest, LATEST_KEYS, `${label}.latest`);
}

function reviewSnapshot(value: unknown): ReviewSnapshot {
  return value as ReviewSnapshot;
}

const requestedEntry = process.env.SMOKE_ENTRY;
const entryURL = requestedEntry
  ? requestedEntry.includes("://")
    ? requestedEntry
    : pathToFileURL(resolve(requestedEntry)).href
  : new URL("../server.js", import.meta.url).href;

const server = (await import(entryURL)) as unknown as PluginModule;

async function register(host: Host, config: SmokeConfig, router: RouterStub): Promise<Cleanup> {
  return server.registerPlugin(host.ctx, { loadConfig: async () => config, router });
}

async function m1(): Promise<void> {
  assert(server.default.id === "capybearista.opencode-auto-advisor", "M1 built server id mismatch");
  assert(typeof server.default.setup === "function", "M1 built server setup is not a function");
  assert(!("tui" in server.default), "M8 server plugin must not expose a TUI entrypoint");
  assert(!("server" in server.default), "M8 plugin definition must not expose a V1 server hook");

  const host = createHost({
    agentGet: async () => ({
      data: { permissions: [{ action: "advisor", resource: "*", effect: "allow" }] },
    }),
  });
  const cleanup = await server.default.setup(host.ctx);

  assert(host.tools.length === 1, `M1 expected one tool, saw ${host.tools.length}`);
  const tool = host.tools[0];
  assert(tool !== undefined, "M1 advisor tool missing");
  assert(tool.name === ADVISOR_TOOL_NAME, `M1 tool name ${tool.name}`);
  assert(tool.input.type === "object", "M1 tool input must be an object schema");
  assert(Object.keys(tool.input.properties).length === 0, "M1 tool must take no arguments");
  assert(tool.input.additionalProperties === false, "M1 tool must reject extra arguments");
  assert(tool.input.required === undefined, "M1 tool must not require arguments");
  assert(tool.description.length > 0, "M1 tool description empty");
  assert(tool.options?.codemode === false, "M1 tool must disable codemode");
  assert(
    tool.options?.permission === ADVISOR_TOOL_NAME,
    "M1 tool must declare the native advisor permission",
  );

  assert(
    JSON.stringify(host.hooks) === JSON.stringify(["context", "compaction"]),
    `M1 named hooks mismatch: ${JSON.stringify(host.hooks)}`,
  );
  const telemetry = host.rpcRegistrations.get(TELEMETRY_RPC_ID);
  const review = host.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(telemetry !== undefined, "M1 telemetry rpc missing");
  assert(review !== undefined, "M1 review rpc missing");
  assert(
    Object.keys(telemetry.definition.events ?? {}).length === 0,
    "M1 telemetry rpc must stay read-only without events",
  );
  assert(
    JSON.stringify(Object.keys(review.definition.events ?? {}).sort()) ===
      JSON.stringify(["review.finished", "review.started"]),
    "M1 review rpc must declare start and finish events",
  );
  assert(host.signals.length === 1, "M8 event subscription missing");

  const primary = dispatch({ kind: "primary" });
  await fire(host, "context", primary);
  assert(
    primary.system.filter((part) => part.text?.includes(EXECUTOR_GUIDANCE_NEEDLE)).length === 1,
    "M2 eligible root dispatch must receive advisor guidance exactly once",
  );
  assert(
    Object.hasOwn(primary.tools, ADVISOR_TOOL_NAME),
    "M2 eligible root dispatch must keep the advisor tool",
  );
  assert(primary.messages.length === 1, "M4 off mode must not inject advice");
  assert(host.prompts.length === 0, "M4 off mode must not generate");
  assert(host.contextReads.length === 0, "M4 off mode must not read session history");
  assert(!host.values.has("head"), "M4 off mode must not record telemetry");

  await cleanup();
  await cleanup();
  assert(host.signals[0]?.aborted === true, "M8 cleanup must abort the event subscription");
  assert(
    JSON.stringify(host.disposers) ===
      JSON.stringify([
        "hook:context",
        `rpc:${REVIEW_RPC_ID}`,
        `rpc:${TELEMETRY_RPC_ID}`,
        "hook:compaction",
        `tool:${ADVISOR_TOOL_NAME}`,
      ]),
    `M8 cleanup order mismatch: ${JSON.stringify(host.disposers)}`,
  );
  assert(telemetry.disposed === 1, "M8 telemetry rpc must dispose exactly once");
  assert(review.disposed === 1, "M8 review rpc must dispose exactly once");
}

async function m2(): Promise<void> {
  const parentedHost = createHost({
    sessionGet: async () => ({ parentID: "ses_parent", permissions: [] }),
  });
  const parentedRouter = acceptingRouter();
  const parentedCleanup = await register(parentedHost, smokeConfig("active"), parentedRouter);
  const parentedDispatch = dispatch({ kind: "primary" });
  await fire(parentedHost, "context", parentedDispatch);
  assert(
    !Object.hasOwn(parentedDispatch.tools, ADVISOR_TOOL_NAME),
    "M2 parented session must remove the advisor tool",
  );
  assert(parentedDispatch.system.length === 1, "M2 parented session must not receive guidance");
  assert(parentedRouter.evaluated.length === 0, "M2 parented session must not auto-route");
  assert(parentedHost.prompts.length === 0, "M2 parented session must not consult");
  await parentedCleanup();

  const deniedHost = createHost({
    agentGet: async () => ({
      data: { permissions: [{ action: "advisor", resource: "*", effect: "deny" }] },
    }),
  });
  const deniedRouter = acceptingRouter();
  const deniedCleanup = await register(deniedHost, smokeConfig("active"), deniedRouter);
  const deniedDispatch = dispatch({ kind: "primary" });
  await fire(deniedHost, "context", deniedDispatch);
  assert(
    !Object.hasOwn(deniedDispatch.tools, ADVISOR_TOOL_NAME),
    "M2 configured deny must remove the advisor tool",
  );
  assert(deniedDispatch.system.length === 1, "M2 configured deny must not receive guidance");
  assert(deniedRouter.evaluated.length === 0, "M2 configured deny must not auto-route");
  assert(deniedHost.prompts.length === 0, "M2 configured deny must not consult");
  await deniedCleanup();
}

async function m3(): Promise<void> {
  const host = createHost({ messages: DURABLE_MESSAGES });
  const cleanup = await register(host, smokeConfig("off"), acceptingRouter());
  await fire(host, "context", dispatch({ kind: "primary" }));
  const tool = host.tools[0];
  assert(tool !== undefined, "M3 advisor tool missing");

  const result = await tool.execute({}, toolContext());
  assert(result.content === "smoke advice", "M3 explicit consult must return the advice");
  const call = host.prompts[0];
  assert(call !== undefined, "M3 explicit consult must generate exactly once");
  assert(
    call.model?.providerID === "opencode" && call.model.id === "jev-1.14",
    "M3 explicit consult must inherit the in-flight executor model",
  );
  assert(
    occurrences(call.prompt, "hook-only system mutation") === 1,
    "M3 prompt must include the hook-time system exactly once",
  );
  assert(
    occurrences(call.prompt, "hook-only user message") === 1,
    "M3 prompt must include the hook-time user turn exactly once",
  );
  assert(call.prompt.includes("durable assistant delta"), "M3 prompt must include the delta");
  assert(
    call.prompt.includes("TOOL_EVIDENCE_NONCE"),
    "M3 projection must include raw tool evidence",
  );
  assert(
    !call.prompt.includes("SECRET_REASONING_NONCE"),
    "M3 projection must exclude assistant reasoning",
  );
  await cleanup();

  const overrideHost = createHost({ messages: DURABLE_MESSAGES });
  const overrideCleanup = await register(
    overrideHost,
    smokeConfig("off", { advisorModel: { providerID: "anthropic", id: "claude-sonnet-4" } }),
    acceptingRouter(),
  );
  await fire(overrideHost, "context", dispatch({ kind: "primary" }));
  const overrideResult = await overrideHost.tools[0]?.execute({}, toolContext());
  assert(
    overrideHost.prompts[0]?.model?.id === "claude-sonnet-4",
    "M3 configured advisor model must override the executor model",
  );
  assert(
    overrideResult?.metadata?.advisorModel === "anthropic/claude-sonnet-4",
    "M3 explicit result must report the override model",
  );
  await overrideCleanup();

  const errorHost = createHost({
    messages: DURABLE_MESSAGES,
    generate: async () => {
      throw new Error("provider exploded");
    },
  });
  const errorRouter = acceptingRouter();
  const errorCleanup = await register(errorHost, smokeConfig("observe"), errorRouter);
  await fire(errorHost, "context", dispatch({ kind: "primary" }));
  const eventsBefore = telemetryEvents(errorHost).length;
  const errorResult = await errorHost.tools[0]?.execute({}, toolContext());
  assert(
    errorResult?.content?.includes("provider exploded") === true,
    "M3 direct model error must surface in the tool result",
  );
  assert(errorHost.prompts.length === 1, "M3 direct model error must not retry or fall back");
  assert(
    errorRouter.evaluated.length === 1,
    "M3 explicit failure must not enter the Jev routing chain",
  );
  assert(
    telemetryEvents(errorHost).length === eventsBefore,
    "M3 explicit failure must not consume quota or write routing telemetry",
  );
  await errorCleanup();

  const held = heldGeneration();
  const timeoutHost = createHost({ messages: DURABLE_MESSAGES, generate: held.text });
  const timeoutRouter = acceptingRouter();
  const timeoutCleanup = await register(
    timeoutHost,
    smokeConfig("observe", { timeoutMs: 25 }),
    timeoutRouter,
  );
  await fire(timeoutHost, "context", dispatch({ kind: "primary" }));
  const timeoutResult = await timeoutHost.tools[0]?.execute({}, toolContext());
  assert(
    timeoutResult?.content?.includes("timed out") === true,
    "M3 soft timeout must surface in the tool result",
  );
  assert(timeoutHost.prompts.length === 1, "M3 soft timeout must not retry or fall back");
  assert(
    timeoutRouter.evaluated.length === 1,
    "M3 soft timeout must not enter the Jev routing chain",
  );
  held.resolve("late explicit advice");
  await ticks();
  assert(timeoutHost.prompts.length === 1, "M3 late resolution must not trigger another call");
  await timeoutCleanup();
}

async function m4(): Promise<void> {
  const held = heldGeneration();
  const host = createHost({ generate: held.text });
  const router = acceptingRouter();
  const config = smokeConfig("off");
  const cleanup = await register(host, config, router);

  await fire(host, "context", turn(TURN_ONE, "off prompt"));
  assert(router.evaluated.length === 0, "M4 off must not evaluate");
  assert(host.prompts.length === 0, "M4 off must not generate");
  assert(!host.values.has("head"), "M4 off must not record telemetry");

  config.routing.mode = "observe";
  const observeDispatch = turn(TURN_TWO, "observe prompt");
  await fire(host, "context", observeDispatch);
  assert(router.evaluated.length === 1, "M4 observe must evaluate");
  assert(host.prompts.length === 0, "M4 observe must not generate");
  assert(observeDispatch.messages.length === 1, "M4 observe must not inject into messages");
  assert(
    !observeDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M4 observe must not inject advice into the system context",
  );
  const observeEvent = telemetryEvents(host).at(-1);
  assert(
    observeEvent?.mode === "observe" && observeEvent.decision === "accept",
    "M4 observe telemetry must record the hypothetical accept",
  );
  assert(
    observeEvent?.advisorInvocations === undefined && observeEvent?.delivered === undefined,
    "M4 observe must not record delivery or invocations",
  );

  config.routing.mode = "active";
  const activeDispatch = turn("msg-user-3", "active prompt");
  let settled = false;
  const pending = Promise.resolve(fire(host, "context", activeDispatch)).then(() => {
    settled = true;
  });
  await held.started;
  assert(!settled, "M4 active hook must block while generation is held");
  assert(host.prompts.length === 1, "M4 active must consult once");
  assert(activeDispatch.messages.length === 1, "M4 active must not inject before delivery");
  assert(
    !activeDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M4 active must not publish system advice before generation settles",
  );
  const review = host.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(review !== undefined, "M7 review rpc missing");
  const running = reviewSnapshot(await review.handlers.status({ sessionID: SESSION_ID }));
  assert(running.running.length === 1, "M7 held review status must show one running review");
  assert(running.lastFinished === undefined, "M7 held review must not be finished");
  assertReviewSnapshot(running, "M7 held status");
  assert(
    !JSON.stringify(running).includes("hook-only user message"),
    "M7 review status must not expose prompt input",
  );
  assert(
    !JSON.stringify(running).includes(ADVISOR_DELIVERY_PREFIX),
    "M7 held review status must not publish advice before delivery",
  );
  await tick();
  assert(
    review.emitted.filter(([name]) => name === "review.started").length === 1,
    "M7 review.started must emit once",
  );
  assert(
    review.emitted.filter(([name]) => name === "review.finished").length === 0,
    "M7 review.finished must wait for delivery",
  );

  held.resolve("FINAL-ADVICE-NONCE");
  await pending;
  await tick();
  assert(
    activeDispatch.messages.length === 1,
    "M4 active must leave the conversation messages unchanged",
  );
  assert(
    activeDispatch.messages.every((message) => message.role === "user"),
    "M4 active must not fabricate a system or tool conversation message",
  );
  assert(
    activeDispatch.system.filter((part) => part.text?.includes(EXECUTOR_GUIDANCE_NEEDLE)).length ===
      1,
    "M4 active must keep advisor guidance exactly once",
  );
  const adviceParts = activeDispatch.system.filter((part) =>
    part.text?.includes(ADVISOR_DELIVERY_PREFIX),
  );
  assert(
    adviceParts.length === 1,
    "M4 active must inject accepted advice into the system context exactly once",
  );
  assert(adviceParts[0]?.type === "text", "M4 system advice must be a text part");
  assert(
    adviceParts[0]?.text?.includes("FINAL-ADVICE-NONCE") === true,
    "M4 system advice must carry the prefix and advice text",
  );
  assert(
    activeDispatch.system.at(-1)?.text?.includes(ADVISOR_DELIVERY_PREFIX) === true,
    "M4 system advice must append after the guidance part",
  );

  const finished = review.emitted.filter(([name]) => name === "review.finished");
  assert(finished.length === 1, "M7 review.finished must emit once on delivery");
  assertReviewSnapshot(finished[0]?.[1], "M7 finished event");
  const finishedStatus = reviewSnapshot(await review.handlers.status({ sessionID: SESSION_ID }));
  assert(finishedStatus.running.length === 0, "M7 finished review must clear running");
  assert(
    finishedStatus.lastFinished?.outcome === "completed",
    "M7 delivered review must finish completed",
  );
  assert(
    finishedStatus.latest?.advice === "FINAL-ADVICE-NONCE",
    "M7 delivered review must publish the latest advice",
  );

  const accept = telemetryEvents(host).find(
    (event) => event.mode === "active" && event.decision === "accept",
  );
  assert(accept !== undefined, "M4 active telemetry accept missing");
  assert(
    accept.delivered === true &&
      accept.advisorInvocations === 1 &&
      accept.advisorOutcome === "completed",
    "M4 active telemetry delivery mismatch",
  );
  assert(accept.advisorModel === "opencode/jev-1.13", "M4 advisor model mismatch");
  const diagnostics = accept.advisorContext as
    | {
        readonly complete?: boolean;
        readonly estimatedTokens?: number;
        readonly inputBudget?: number;
      }
    | undefined;
  assert(diagnostics?.complete === true, "M4 projection must fit the full context");
  assert(diagnostics?.inputBudget === 150_000, "M4 input budget must honor the catalog limits");
  assert(
    typeof diagnostics?.estimatedTokens === "number" &&
      diagnostics.estimatedTokens <= (diagnostics.inputBudget ?? 0),
    "M4 final estimate must fit the budget",
  );
  const acceptJSON = JSON.stringify(accept);
  assert(
    !acceptJSON.includes("hook-only user message") && !acceptJSON.includes("FINAL-ADVICE-NONCE"),
    "M4 telemetry must stay digest-only",
  );

  const evaluatedBeforeAux = router.evaluated.length;
  const promptsBeforeAux = host.prompts.length;
  const aux = dispatch({ kind: "compaction" });
  await fire(host, "context", aux);
  assert(
    router.evaluated.length === evaluatedBeforeAux && host.prompts.length === promptsBeforeAux,
    `M4 auxiliary dispatch must not route or consult (evaluated=${router.evaluated.length}, prompts=${host.prompts.length})`,
  );
  await cleanup();
}

async function m5(): Promise<void> {
  const host = createHost({ messages: SIMPLE_DURABLE_MESSAGES });
  const router = acceptingRouter();
  const cleanup = await register(host, smokeConfig("active"), router);

  await fire(host, "context", dispatch({ kind: "primary" }));
  assert(router.evaluated.length === 1, "M5 first automatic opportunity must evaluate");
  assert(host.prompts.length === 1, "M5 first automatic opportunity must consult");

  const result = await host.tools[0]?.execute({}, toolContext());
  assert(result?.content === "smoke advice", "M5 explicit consult must succeed");
  assert(host.prompts.length === 2, "M5 explicit consult must generate once");

  const equivalent = dispatch({
    kind: "primary",
    messages: [
      { id: TURN_ONE, role: "user", content: [{ type: "text", text: "hook-only user message" }] },
      {
        id: IN_FLIGHT_ASSISTANT,
        role: "assistant",
        content: [{ type: "text", text: "persisted assistant delta" }],
      },
    ],
  });
  await fire(host, "context", equivalent);
  assert(
    router.evaluated.length === 1,
    "M5 explicit success must suppress an equivalent automatic opportunity",
  );
  assert(host.prompts.length === 2, "M5 suppressed opportunity must not consult or consume quota");

  await fire(host, "context", turn("msg-user-3", "meaningful new material"));
  assert(router.evaluated.length === 2, "M5 meaningful new material must open an opportunity");
  assert(host.prompts.length === 3, "M5 new opportunity must consult");
  await cleanup();
}

async function m6(): Promise<void> {
  const host = createHost();
  const cleanup = await register(host, smokeConfig("active"), acceptingRouter());

  await fire(host, "context", dispatch({ kind: "primary" }));
  const firstRecords = adviceRecords(host, SESSION_ID);
  assert(firstRecords.length === 1, "M6 successful active consult must persist an actual record");
  assert(firstRecords[0]?.advice === "smoke advice", "M6 record must carry the delivered advice");
  assert(firstRecords[0]?.turnKey === TURN_ONE, "M6 record must carry the turn key");

  const next = turn(TURN_TWO, "second turn");
  const retainedCount = (): number =>
    next.system.filter((part) => part.text?.includes(RETAINED_REVIEWS_MARKER)).length;
  await fire(host, "context", next);
  assert(retainedCount() === 1, "M6 retained reviews must inject once into the system context");
  assert(
    next.system.filter((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)).length === 1,
    "M6 next turn must deliver its accepted advice into the system context once",
  );
  assert(next.messages.length === 1, "M6 retained delivery must leave messages unchanged");
  const systemPartsAfterFirst = next.system.length;
  await fire(host, "context", next);
  assert(retainedCount() === 1, "M6 reused dispatch must not multiply retained reviews");
  assert(
    next.system.length === systemPartsAfterFirst,
    "M6 reused dispatch must not append more system parts",
  );
  assert(next.messages.length === 1, "M6 reused dispatch must not append more messages");
  assert(adviceRecords(host, SESSION_ID).length === 2, "M6 second turn must persist its record");

  const compaction = compactionEvent();
  await fire(host, "compaction", compaction);
  const block = compaction.system[0]?.text ?? "";
  assert(
    block.includes(COMPACTION_BLOCK_START) && block.includes(COMPACTION_BLOCK_END),
    "M6 compaction hook must frame the retention block",
  );
  assert(
    !block.includes("advisor()"),
    "M6 compaction framing must not present reviews as tool instructions",
  );
  assert(
    (compaction.result.summary ?? "").includes(COMPACTION_BLOCK_START),
    "M6 compaction result summary must carry the retention block",
  );

  host.events.push({
    type: "session.compaction.ended",
    data: { sessionID: SESSION_ID, text: block },
  });
  await ticks();
  assert(
    adviceRecords(host, SESSION_ID).length === 0,
    "M6 exact compaction proof must retire captured records",
  );

  const review = host.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(review !== undefined, "M6 review rpc missing");
  const beforeDeletion = reviewSnapshot(await review.handlers.status({ sessionID: SESSION_ID }));
  host.events.push({ type: "session.deleted", data: { sessionID: SESSION_ID } });
  await ticks();
  const deleted = reviewSnapshot(await review.handlers.status({ sessionID: SESSION_ID }));
  assert(
    deleted.running.length === 0 &&
      deleted.lastFinished === undefined &&
      deleted.latest === undefined,
    `M6 session deletion must clear review state (${JSON.stringify(deleted)})`,
  );
  assert(
    typeof deleted.revision === "number" &&
      typeof beforeDeletion.revision === "number" &&
      deleted.revision >= beforeDeletion.revision,
    `M6 deletion must not regress the review revision (${JSON.stringify({ before: beforeDeletion.revision, after: deleted.revision })})`,
  );
  await cleanup();

  const failedHost = createHost();
  const failedCleanup = await register(failedHost, smokeConfig("active"), acceptingRouter());
  await fire(failedHost, "context", dispatch({ kind: "primary" }));
  assert(adviceRecords(failedHost, SESSION_ID).length === 1, "M6 failed-preserve needs a record");
  await fire(failedHost, "compaction", compactionEvent());
  failedHost.events.push({
    type: "session.compaction.failed",
    data: { sessionID: SESSION_ID, reason: "auto", error: { type: "x", message: "y" } },
  });
  await ticks();
  assert(adviceRecords(failedHost, SESSION_ID).length === 1, "M6 failed compaction must preserve");
  failedHost.events.push({
    type: "session.compaction.ended",
    data: { sessionID: SESSION_ID, text: "paraphrased summary without the exact block" },
  });
  await ticks();
  assert(
    adviceRecords(failedHost, SESSION_ID).length === 1,
    "M6 paraphrased compaction must preserve",
  );
  await failedCleanup();

  const commitFailOptions: HostOptions = { failAdviceWrites: false };
  const commitFailHost = createHost(commitFailOptions);
  const commitFailCleanup = await register(
    commitFailHost,
    smokeConfig("active"),
    acceptingRouter(),
  );
  await fire(commitFailHost, "context", dispatch({ kind: "primary" }));
  assert(
    adviceRecords(commitFailHost, SESSION_ID).length === 1,
    "M6 commit-failure flow must first persist a prior review",
  );

  commitFailOptions.failAdviceWrites = true;
  const commitFailDispatch = turn(TURN_TWO, "commit failure turn");
  await fire(commitFailHost, "context", commitFailDispatch);
  const commitFailReview = commitFailHost.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(commitFailReview !== undefined, "M6 commit-failure review rpc missing");
  const commitFailStatus = reviewSnapshot(
    await commitFailReview.handlers.status({ sessionID: SESSION_ID }),
  );
  assert(
    commitFailStatus.lastFinished?.outcome === "failed",
    "M6 commit failure must finish the review failed",
  );
  assert(
    commitFailStatus.latest?.advice === "smoke advice",
    "M6 commit failure must preserve the prior published review",
  );
  assert(
    commitFailDispatch.messages.length === 1 &&
      commitFailDispatch.messages.every((message) => message.role === "user"),
    "M6 commit failure must not deliver advice into the conversation messages",
  );
  assert(
    commitFailDispatch.system.filter((part) => part.text?.includes(RETAINED_REVIEWS_MARKER))
      .length === 1,
    "M6 commit failure must keep the prior retained review in the system context",
  );
  assert(
    !commitFailDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M6 commit failure must not publish extra accepted advice",
  );
  assert(
    telemetryEvents(commitFailHost).at(-1)?.delivered === false,
    "M6 commit failure must record delivered false",
  );
  assert(
    adviceRecords(commitFailHost, SESSION_ID).length === 1,
    "M6 commit failure must not persist a new record or drop the prior one",
  );
  await commitFailCleanup();

  const pendingHeld = heldGeneration();
  const pendingHost = createHost({ generate: pendingHeld.text });
  const pendingCleanup = await register(pendingHost, smokeConfig("active"), acceptingRouter());
  const pendingDispatch = dispatch({ kind: "primary" });
  const pending = Promise.resolve(fire(pendingHost, "context", pendingDispatch));
  await pendingHeld.started;
  const pendingReview = pendingHost.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(pendingReview !== undefined, "M6 pending-deletion review rpc missing");
  assert(
    reviewSnapshot(await pendingReview.handlers.status({ sessionID: SESSION_ID })).running
      .length === 1,
    "M6 pending-deletion fixture must hold a running review",
  );
  pendingHost.events.push({ type: "session.deleted", data: { sessionID: SESSION_ID } });
  await ticks();
  pendingHeld.resolve("late deleted advice");
  await pending;
  await tick();
  assert(
    pendingDispatch.messages.length === 1,
    "M6 deletion must suppress a pending review delivery",
  );
  assert(
    !pendingDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M6 deletion must suppress pending system advice",
  );
  const pendingAfter = reviewSnapshot(
    await pendingReview.handlers.status({ sessionID: SESSION_ID }),
  );
  assert(
    pendingAfter.running.length === 0 && pendingAfter.latest === undefined,
    `M6 deletion must not resume a pending review (${JSON.stringify(pendingAfter)})`,
  );
  assert(
    telemetryEvents(pendingHost).length === 0,
    "M6 deletion must suppress late review telemetry",
  );
  assert(
    adviceRecords(pendingHost, SESSION_ID).length === 0,
    "M6 deletion must not persist a pending review record",
  );
  await pendingCleanup();
}

async function m7(): Promise<void> {
  const host = createHost();
  const cleanup = await register(host, smokeConfig("active"), acceptingRouter());
  const review = host.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(review !== undefined, "M7 review rpc missing");
  const unknown = reviewSnapshot(await review.handlers.status({ sessionID: "ses_unknown" }));
  assert(
    typeof unknown.revision === "number" &&
      unknown.running.length === 0 &&
      unknown.lastFinished === undefined &&
      unknown.latest === undefined,
    "M7 unknown session must return an empty snapshot",
  );
  assertReviewSnapshot(unknown, "M7 unknown status");
  await cleanup();

  const held = heldGeneration();
  const timeoutHost = createHost({ generate: held.text });
  const timeoutCleanup = await register(
    timeoutHost,
    smokeConfig("active", { timeoutMs: 25 }),
    acceptingRouter(),
  );
  const timeoutDispatch = dispatch({ kind: "primary" });
  await fire(timeoutHost, "context", timeoutDispatch);
  await tick();
  assert(timeoutDispatch.messages.length === 1, "M7 timeout must not deliver advice");
  assert(
    !timeoutDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M7 timeout must not deliver system advice",
  );
  const timeoutReview = timeoutHost.rpcRegistrations.get(REVIEW_RPC_ID);
  assert(timeoutReview !== undefined, "M7 timeout review rpc missing");
  const timeoutStatus = reviewSnapshot(
    await timeoutReview.handlers.status({ sessionID: SESSION_ID }),
  );
  assert(timeoutStatus.running.length === 0, "M7 timeout must clear running reviews quietly");
  assert(timeoutStatus.lastFinished?.outcome === "timeout", "M7 timeout must finish as timeout");
  assert(timeoutStatus.latest === undefined, "M7 timeout must not publish advice");
  const timeoutFinished = timeoutReview.emitted.filter(([name]) => name === "review.finished");
  assert(timeoutFinished.length === 1, "M7 timeout must emit one finished event");
  assertReviewSnapshot(timeoutFinished[0]?.[1], "M7 timeout event");
  const timeoutEvent = telemetryEvents(timeoutHost).at(-1);
  assert(
    timeoutEvent?.advisorOutcome === "timeout" && timeoutEvent?.advisorTimedOut === true,
    "M7 timeout telemetry must record the timeout outcome",
  );
  held.resolve("late timeout advice");
  await ticks();
  assert(timeoutDispatch.messages.length === 1, "M7 late resolution must stay quiet");
  assert(
    !timeoutDispatch.system.some((part) => part.text?.includes(ADVISOR_DELIVERY_PREFIX)),
    "M7 late resolution must not publish system advice",
  );
  const late = reviewSnapshot(await timeoutReview.handlers.status({ sessionID: SESSION_ID }));
  assert(late.latest === undefined, "M7 late resolution must not publish advice");
  await timeoutCleanup();
}

async function m8(): Promise<void> {
  const host = createHost();
  const cleanup = await register(host, smokeConfig("active"), acceptingRouter());
  assert(
    JSON.stringify(host.hooks) === JSON.stringify(["context", "compaction"]),
    "M8 full host must register both named hooks",
  );
  assert(host.rpcRegistrations.size === 2, "M8 full host must register both rpcs");
  assert(host.signals.length === 1, "M8 full host must subscribe to events");
  await cleanup();
  await cleanup();
  assert(host.signals[0]?.aborted === true, "M8 cleanup must abort the event subscription");
  assert(
    JSON.stringify(host.disposers) ===
      JSON.stringify([
        "hook:context",
        `rpc:${REVIEW_RPC_ID}`,
        `rpc:${TELEMETRY_RPC_ID}`,
        "hook:compaction",
        `tool:${ADVISOR_TOOL_NAME}`,
      ]),
    `M8 full host cleanup order mismatch: ${JSON.stringify(host.disposers)}`,
  );
  for (const registration of host.rpcRegistrations.values()) {
    assert(registration.disposed === 1, "M8 rpc registrations must dispose exactly once");
  }
}

const failures: string[] = [];

async function group(id: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    process.stdout.write(`smoke: ${id} ok\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push(`${id}: ${message}`);
    process.stdout.write(`smoke: ${id} FAILED: ${message}\n`);
  }
}

const configDirectory = await mkdtemp(join(tmpdir(), "auto-advisor-smoke-"));
const previousConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
process.env.OPENCODE_CONFIG_DIR = configDirectory;
try {
  await group("M1 entry-registration", m1);
  await group("M2 eligibility", m2);
  await group("M3 explicit-consult", m3);
  await group("M4 modes-delivery", m4);
  await group("M5 explicit-suppression", m5);
  await group("M6 retention-compaction", m6);
  await group("M7 review-rpc", m7);
  await group("M8 cleanup", m8);
} finally {
  if (previousConfigDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDirectory;
  await rm(configDirectory, { recursive: true, force: true });
}

if (failures.length > 0) {
  throw new Error(`smoke: ${failures.length} matrix group(s) failed:\n${failures.join("\n")}`);
}

process.stdout.write(
  `smoke: ${entryURL} verified M1 package-root entry, zero-argument advisor tool (codemode false, native advisor permission), named context+compaction hooks, telemetry+review RPCs with events, event subscription, no TUI; M2 eligible root allow guidance vs parented/denied tool removal with no auto; M3 explicit model inherit/override, raw tool evidence without reasoning, direct error and soft timeout without Jev fallback; M4 off inert, observe evaluates only, active held until generate then privileged system-context injection with unchanged conversation messages; M5 explicit success suppresses unchanged auto and new material reopens; M6 retained once per turn in the system context, compaction framing, exact-proof retire, failed/paraphrased preserve, deletion cleanup, commit-failure keeps the prior retained review without extra advice; M7 review status running while held, start/finish on delivery, quiet timeout, no payload leak; M8 idempotent cleanup without TUI\n`,
);
