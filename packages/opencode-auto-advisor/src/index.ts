import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { createAdviceLifetime } from "./advice-delivery.js";
import { type AdvisorService, createAdvisorService } from "./advisor-service.js";
import { type AdvisorConfig, loadConfig } from "./config.js";
import { mergeExplicitConsult } from "./consult.js";
import { captureSessionHistory } from "./context.js";
import type { SessionID } from "./messages.js";
import { createModelLimitResolver, type ModelCatalog } from "./model-limits.js";
import { turnKeyForHistory } from "./request.js";
import { registerRoutingObserver } from "./routing-observer.js";
import type { AdvisorRouter } from "./routing-types.js";
import { refKey } from "./serialize-assistant.js";
import { createSnapshotStore } from "./snapshot-store.js";
import { createTelemetryStore } from "./telemetry.js";
import { registerTelemetryRpc } from "./telemetry-rpc.js";
import { createZenEvaluation } from "./zen-evaluation.js";
import { createZenRouter } from "./zen-router.js";

const PLUGIN_ID = "capybearista.opencode-auto-advisor";
export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_TOOL_DESCRIPTION =
  "Consult the independent Auto Advisor for a second opinion on the current working context. " +
  "Call with no arguments; the Advisor reads this session's context itself and returns actionable advice.";

type AdvisorContext = Pick<PluginContext, "tool" | "session" | "generate"> &
  Partial<Pick<PluginContext, "storage" | "integration" | "event" | "rpc">> & {
    readonly model?: { readonly list?: ModelCatalog["list"] };
  };

export interface AdvisorPluginOptions {
  readonly loadConfig?: () => Promise<AdvisorConfig>;
  readonly router?: AdvisorRouter;
}

export function buildAdvisorService(
  context: AdvisorContext,
  options: AdvisorPluginOptions = {},
): AdvisorService {
  return createAdvisorService({
    loadConfig: options.loadConfig ?? loadConfig,
    generateText: (input) => context.generate.text(input),
  });
}

export async function registerPlugin(
  context: AdvisorContext,
  options: AdvisorPluginOptions = {},
): Promise<() => Promise<void>> {
  const load = options.loadConfig ?? loadConfig;
  const service = buildAdvisorService(context, { loadConfig: load });
  const snapshots = createSnapshotStore();
  const telemetry = context.storage ? createTelemetryStore(context.storage) : undefined;
  const lifetime = createAdviceLifetime();
  const zen = createZenEvaluation({ connection: context.integration?.connection });
  const router = options.router ?? createZenRouter({ loadConfig: load, evaluation: zen });
  const resolveLimits = createModelLimitResolver(hostModelCatalog(context));

  const registration = await context.tool.transform((editor) => {
    editor.add({
      name: ADVISOR_TOOL_NAME,
      description: ADVISOR_TOOL_DESCRIPTION,
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input, toolContext) => {
        try {
          const history = await captureSessionHistory(context.session, {
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
          });
          const snapshot = snapshots.read(toolContext.sessionID, turnKeyForHistory(history));
          const merged = mergeExplicitConsult({
            ...(snapshot ? { snapshot } : {}),
            history,
            messageID: toolContext.messageID,
          });
          const consultation = await service.consult({
            transcript: merged.transcript,
            ...(merged.executorModel ? { executorModel: merged.executorModel } : {}),
          });
          return {
            content: consultation.advice,
            ...(consultation.model
              ? { metadata: { advisorModel: refKey(consultation.model) } }
              : {}),
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return {
            content: `Auto Advisor consultation failed: ${message}`,
            metadata: { error: message },
          };
        }
      },
    });
  });

  const routing = await registerRoutingObserver(context, {
    loadConfig: load,
    router,
    service,
    snapshots,
    resolveLimits,
    ...(telemetry ? { telemetry } : {}),
    lifetime,
  });

  const rpc =
    context.rpc && telemetry ? await registerTelemetryRpc(context.rpc, telemetry) : undefined;

  const controller = new AbortController();
  if (context.event) {
    watchSessionDeletes(context.event, controller.signal, (sessionID) => {
      snapshots.forget(sessionID);
      routing.forget(sessionID);
      lifetime.forget(sessionID);
    });
  }

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    await routing.dispose();
    await rpc?.dispose();
    await zen.dispose();
    await registration.dispose();
  };
}

function hostModelCatalog(context: AdvisorContext): ModelCatalog | undefined {
  const model = context.model;
  if (model === undefined || typeof model.list !== "function") return undefined;
  const list = model.list;
  return { list: () => list.call(model) };
}

function watchSessionDeletes(
  event: PluginContext["event"],
  signal: AbortSignal,
  onDeleted: (sessionID: SessionID) => void,
): void {
  void (async () => {
    for await (const payload of event.subscribe({ signal })) {
      if (payload.type === "session.deleted") onDeleted(payload.data.sessionID as SessionID);
    }
  })().catch(() => undefined);
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: (context) => registerPlugin(context),
});
