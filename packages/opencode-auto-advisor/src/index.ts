import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import {
  type AdviceCompactionRegistration,
  readCompactionEndedEvent,
  readCompactionFailedEvent,
  registerAdviceCompaction,
} from "./advice-compaction.js";
import { retainedReviewEntry } from "./advice-delivery.js";
import { type AdviceHistory, type AdviceRecord, createAdviceHistory } from "./advice-history.js";
import { buildAdvisorProjection } from "./advisor-projection.js";
import { ADVISOR_TOOL_DESCRIPTION } from "./advisor-prompts.js";
import {
  AdvisorInvalidatedError,
  type AdvisorService,
  createAdvisorService,
  resolveAdvisorModel,
} from "./advisor-service.js";
import { type AdvisorConfig, loadConfig } from "./config.js";
import { mergeExplicitConsult } from "./consult.js";
import { captureSessionHistory } from "./context.js";
import { type EligibilitySources, evaluateAdvisorEligibility } from "./eligibility.js";
import { ADVISOR_TOOL_NAME } from "./material.js";
import type { SessionID } from "./messages.js";
import { computeInputBudget, createModelLimitResolver, type ModelCatalog } from "./model-limits.js";
import { createOperationLifetime } from "./operation-lifetime.js";
import { turnKeyForHistory } from "./request.js";
import { createReviewLifecycle } from "./review-lifecycle.js";
import { registerReviewRpc } from "./review-rpc.js";
import { registerRoutingObserver } from "./routing-observer.js";
import type { AdvisorRouter } from "./routing-types.js";
import { refKey } from "./serialize-assistant.js";
import { createSnapshotStore } from "./snapshot-store.js";
import { createTelemetryStore } from "./telemetry.js";
import { registerTelemetryRpc } from "./telemetry-rpc.js";
import { createZenEvaluation } from "./zen-evaluation.js";
import { createZenRouter } from "./zen-router.js";

const PLUGIN_ID = "capybearista.opencode-auto-advisor";

export { ADVISOR_TOOL_DESCRIPTION, ADVISOR_TOOL_NAME };

type AdvisorContext = Pick<PluginContext, "tool" | "session" | "generate"> &
  Partial<Pick<PluginContext, "storage" | "integration" | "event" | "rpc" | "agent">> & {
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
  const operations = createOperationLifetime();
  let disposed = false;
  const load = options.loadConfig ?? loadConfig;
  const service = buildAdvisorService(context, { loadConfig: load });
  const snapshots = createSnapshotStore();
  const telemetry = context.storage ? createTelemetryStore(context.storage) : undefined;
  const history = context.storage ? createAdviceHistory(context.storage) : undefined;
  const lifecycle = createReviewLifecycle();
  const zen = createZenEvaluation({ connection: context.integration?.connection });
  const router = options.router ?? createZenRouter({ loadConfig: load, evaluation: zen });
  const resolveLimits = createModelLimitResolver(hostModelCatalog(context));
  const eligibility: EligibilitySources = {
    session: context.session,
    ...(context.agent ? { agent: context.agent } : {}),
  };

  const registration = await context.tool.transform((editor) => {
    editor.add({
      name: ADVISOR_TOOL_NAME,
      description: ADVISOR_TOOL_DESCRIPTION,
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false, permission: ADVISOR_TOOL_NAME },
      execute: async (_input, toolContext) => {
        const token = operations.begin(toolContext.sessionID);
        const isCurrent = () => !disposed && token.isCurrent();
        try {
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          const admission = await evaluateAdvisorEligibility(eligibility, {
            sessionID: toolContext.sessionID,
            ...(toolContext.agent ? { agentID: toolContext.agent } : {}),
          });
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          if (!admission.eligible) throw new Error(admission.reason);

          const config = await load();
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          const captured = await captureSessionHistory(context.session, {
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
          });
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          const turnKey = turnKeyForHistory(captured);
          const snapshot = snapshots.read(toolContext.sessionID, turnKey);
          const merged = mergeExplicitConsult({
            ...(snapshot ? { snapshot } : {}),
            history: captured,
            messageID: toolContext.messageID,
          });
          const advisorModel = resolveAdvisorModel(config, merged.executorModel);
          if (advisorModel === undefined)
            throw new Error(
              "no advisor model available; configure advisor.model or run with a resolvable executor model",
            );
          const limits = await resolveLimits(advisorModel);
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          const inputBudget = limits === undefined ? undefined : computeInputBudget(limits);
          if (inputBudget === undefined)
            throw new Error(`advisor model limits are unavailable for ${refKey(advisorModel)}`);
          const retained = await explicitRetainedReviews(
            history,
            compaction,
            toolContext.sessionID,
          );
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          const entry = retainedReviewEntry(retained);
          const projection = buildAdvisorProjection(
            entry ? [...merged.entries, entry] : merged.entries,
            { inputBudget },
          );
          const consultation = await service.consult({
            transcript: projection.transcript,
            advisorModel,
            ...(merged.executorModel ? { executorModel: merged.executorModel } : {}),
            isCurrent,
          });
          if (!isCurrent()) throw new AdvisorInvalidatedError();
          routing.markReviewed(toolContext.sessionID, turnKey, merged.entries);
          return {
            content: consultation.advice,
            metadata: { advisorModel: refKey(consultation.model ?? advisorModel) },
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return {
            content: `Auto Advisor consultation failed: ${message}`,
            metadata: { error: message },
          };
        } finally {
          token.release();
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
    ...(history ? { history } : {}),
    lifecycle,
    absorbed: (sessionID) => compaction?.absorbed(sessionID) ?? new Set(),
    operations,
  });

  const compaction: AdviceCompactionRegistration | undefined = history
    ? await registerAdviceCompaction(context.session, { history, eligibility })
    : undefined;

  const rpc =
    context.rpc && telemetry ? await registerTelemetryRpc(context.rpc, telemetry) : undefined;
  const reviewRpc = context.rpc ? await registerReviewRpc(context.rpc, lifecycle) : undefined;

  const controller = new AbortController();
  if (context.event) {
    watchEvents(context.event, controller.signal, {
      deleted: (sessionID) => {
        operations.forget(sessionID);
        snapshots.forget(sessionID);
        routing.forget(sessionID);
        compaction?.forget(sessionID);
        lifecycle.forget(sessionID);
        void history?.forget(sessionID).catch(() => undefined);
      },
      compactionEnded: (sessionID, text) => compaction?.ended(sessionID, text),
      compactionFailed: (sessionID) => compaction?.failed(sessionID),
    });
  }

  return async () => {
    if (disposed) return;
    disposed = true;
    operations.dispose();
    compaction?.invalidate();
    controller.abort();
    await routing.dispose();
    await reviewRpc?.dispose();
    await rpc?.dispose();
    await zen.dispose();
    await compaction?.dispose();
    await registration.dispose();
    history?.dispose();
    lifecycle.dispose();
  };
}

async function explicitRetainedReviews(
  history: AdviceHistory | undefined,
  compaction: AdviceCompactionRegistration | undefined,
  sessionID: SessionID,
): Promise<readonly AdviceRecord[]> {
  if (history === undefined) return [];
  let records: readonly AdviceRecord[];
  try {
    records = await history.get(sessionID);
  } catch {
    return [];
  }
  const absorbed = compaction?.absorbed(sessionID);
  if (absorbed === undefined || absorbed.size === 0) return records;
  return records.filter((record) => !absorbed.has(record.id));
}

function hostModelCatalog(context: AdvisorContext): ModelCatalog | undefined {
  const model = context.model;
  if (model === undefined || typeof model.list !== "function") return undefined;
  const list = model.list;
  return { list: () => list.call(model) };
}

interface EventHandlers {
  readonly deleted: (sessionID: SessionID) => void;
  readonly compactionEnded: (sessionID: SessionID, text: string) => void;
  readonly compactionFailed: (sessionID: SessionID) => void;
}

function watchEvents(
  event: PluginContext["event"],
  signal: AbortSignal,
  handlers: EventHandlers,
): void {
  void (async () => {
    for await (const payload of event.subscribe({ signal })) {
      const deleted = readDeletedSessionID(payload);
      if (deleted !== undefined) {
        handlers.deleted(deleted);
        continue;
      }
      const ended = readCompactionEndedEvent(payload);
      if (ended !== undefined) {
        handlers.compactionEnded(ended.sessionID, ended.text);
        continue;
      }
      const failed = readCompactionFailedEvent(payload);
      if (failed !== undefined) handlers.compactionFailed(failed);
    }
  })().catch(() => undefined);
}

function readDeletedSessionID(payload: unknown): SessionID | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as { readonly type?: unknown; readonly data?: unknown };
  if (candidate.type !== "session.deleted") return undefined;
  const data = candidate.data;
  if (typeof data !== "object" || data === null) return undefined;
  const sessionID = (data as { readonly sessionID?: unknown }).sessionID;
  return typeof sessionID === "string" ? (sessionID as SessionID) : undefined;
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: (context) => registerPlugin(context),
});
