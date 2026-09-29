import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { type AdvisorService, createAdvisorService } from "./advisor-service.js";
import { type AdvisorConfig, loadConfig } from "./config.js";
import { mergeExplicitConsult } from "./consult.js";
import { captureSessionHistory } from "./context.js";
import { turnKeyForHistory } from "./request.js";
import { RouterError } from "./router.js";
import { registerRoutingObserver } from "./routing-observer.js";
import type { AdvisorRouter } from "./routing-types.js";
import { refKey } from "./serialize-assistant.js";
import { createSnapshotStore } from "./snapshot-store.js";

const PLUGIN_ID = "capybearista.opencode-auto-advisor";
export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_TOOL_DESCRIPTION =
  "Consult the independent Auto Advisor for a second opinion on the current working context. " +
  "Call with no arguments; the Advisor reads this session's context itself and returns actionable advice.";

type AdvisorContext = Pick<PluginContext, "tool" | "session" | "generate">;

export interface AdvisorPluginOptions {
  readonly loadConfig?: () => Promise<AdvisorConfig>;
  readonly router?: AdvisorRouter;
}

const UNAVAILABLE_ROUTER: AdvisorRouter = {
  evaluate: async () => {
    throw new RouterError("no advisor router is configured");
  },
};

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
    router: options.router ?? UNAVAILABLE_ROUTER,
    service,
    snapshots,
  });

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    await routing.dispose();
    await registration.dispose();
  };
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: (context) => registerPlugin(context),
});
