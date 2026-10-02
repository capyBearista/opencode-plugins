import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import {
  type AdviceDeliveryInput,
  deliverAdvice,
  deliverRetainedReviews,
  type RetainedReviewDeliveryInput,
  retainedReviewEntry,
} from "./advice-delivery.js";
import type { AdviceHistory, AdviceRecord, AdviceReservation } from "./advice-history.js";
import type { AdvisorProjectionBuilder } from "./advisor-projection.js";
import { EXECUTOR_ADVISOR_GUIDANCE } from "./advisor-prompts.js";
import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig } from "./config.js";
import { type EligibilitySources, evaluateAdvisorEligibility } from "./eligibility.js";
import { ADVISOR_TOOL_NAME } from "./material.js";
import type { AssembledRequest, SessionID } from "./messages.js";
import type { ModelLimitResolver } from "./model-limits.js";
import { createOperationLifetime, type OperationLifetime } from "./operation-lifetime.js";
import { type CapturedRequest, captureAssembledRequest } from "./request.js";
import type { ReviewHandle, ReviewLifecycle } from "./review-lifecycle.js";
import {
  ADVISOR_HISTORY_CAPACITY_SKIP_REASON,
  ADVISOR_HISTORY_UNAVAILABLE_SKIP_REASON,
  createRoutingDomain,
} from "./routing.js";
import type { AdvisorRouter, AutomaticPreparation, RoutingDecision } from "./routing-types.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { TelemetryEventInput, TelemetrySink } from "./telemetry-types.js";

export const ADVISOR_PERSISTENCE_ERROR_CLASS = "PersistenceError";

type ObserverContext = Pick<PluginContext, "session"> & Partial<Pick<PluginContext, "agent">>;

export interface RoutingObserverDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
  readonly snapshots: SnapshotStore;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
  readonly telemetry?: TelemetrySink;
  readonly deliver?: (input: AdviceDeliveryInput) => void;
  readonly deliverRetained?: (input: RetainedReviewDeliveryInput) => void;
  readonly history?: AdviceHistory;
  readonly lifecycle?: ReviewLifecycle;
  readonly absorbed?: (sessionID: SessionID) => ReadonlySet<string>;
  readonly operations?: OperationLifetime;
}

export interface RoutingObserverRegistration {
  readonly dispose: () => Promise<void>;
  readonly forget: (sessionID: CapturedRequest["sessionID"]) => void;
  readonly markReviewed: (
    sessionID: CapturedRequest["sessionID"],
    turnKey: string,
    entries: CapturedRequest["entries"],
  ) => void;
}

export async function registerRoutingObserver(
  context: ObserverContext,
  deps: RoutingObserverDeps,
): Promise<RoutingObserverRegistration> {
  const domain = createRoutingDomain(deps);
  const ownedGuidance = new WeakSet<object>();
  const ownedDelivery = new WeakSet<object>();
  const retainedInjected = new WeakSet<object>();
  const operations = deps.operations ?? createOperationLifetime();
  const ownsOperations = deps.operations === undefined;
  let disposed = false;
  const eligibility: EligibilitySources = {
    session: context.session,
    ...(context.agent ? { agent: context.agent } : {}),
  };
  const registration = await context.session.hook("context", async (dispatch) => {
    const kind = readDispatchKind(dispatch);
    if (kind !== undefined && kind !== "primary") return;
    const sessionID = readSessionID(dispatch);
    if (sessionID === undefined || !advertisesAdvisor(dispatch)) return;
    const token = operations.begin(sessionID);
    const isCurrent = () => !disposed && token.isCurrent();
    try {
      const agentID = readAgent(dispatch);
      const admission = await evaluateAdvisorEligibility(eligibility, {
        sessionID,
        ...(agentID ? { agentID } : {}),
      });
      if (!isCurrent()) return;
      if (!admission.eligible) {
        removeAdvisorTool(dispatch);
        return;
      }
      let captured: CapturedRequest;
      try {
        captured = captureAssembledRequest(
          canonicalRequest(dispatch, ownedGuidance, ownedDelivery),
        );
      } catch {
        return;
      }
      if (!isCurrent()) return;
      deps.snapshots.capture({
        sessionID: captured.sessionID,
        turnKey: captured.turnKey,
        entries: captured.entries,
        executorModel: captured.executorModel,
      });
      injectGuidance(dispatch, ownedGuidance);

      let grant: AdviceReservation | undefined;
      let retained: readonly AdviceRecord[] = [];
      let handle: ReviewHandle | undefined;
      let advisorStartedAt = 0;
      try {
        const started = Date.now();
        const decision = await domain.observe({
          sessionID: captured.sessionID,
          ...(kind === "primary" ? { kind } : {}),
          isCurrent,
          capture: async () => {
            retained = await loadRetained(deps, captured.sessionID);
            const entry = retainedReviewEntry(visibleRetained(deps, captured.sessionID, retained));
            return {
              entries: captured.entries,
              lastUserMessageID: captured.turnKey,
              executorModel: captured.executorModel,
              ...(entry ? { advisorEntries: [entry] } : {}),
            };
          },
          prepareAutomatic: async () =>
            prepareAutomatic(deps, captured.sessionID, (reservation) => {
              grant = reservation;
            }),
          onAdvisorStart: () => {
            if (!isCurrent()) return;
            try {
              handle = deps.lifecycle?.begin(captured.sessionID);
              advisorStartedAt = Date.now();
            } catch {
              handle = undefined;
            }
          },
        });
        if (!isCurrent()) return;

        const accepted =
          decision.action === "accept" &&
          decision.mode === "active" &&
          decision.advice !== undefined;
        const persisted = accepted
          ? await commitAdvice(deps, grant, captured, decision)
          : undefined;
        if (!isCurrent()) return;
        const persistenceFailed = accepted && persisted === undefined;
        if (decision.mode === "active") {
          injectRetained(
            deps,
            dispatch,
            ownedDelivery,
            retainedInjected,
            visibleRetained(deps, captured.sessionID, retained),
          );
        }
        const effective = persistenceFailed ? persistenceFailure(decision) : decision;
        const delivered = persistenceFailed
          ? false
          : deliverAccepted(deps, dispatch, ownedDelivery, decision);
        finishLifecycle(deps, handle, effective, delivered);
        if (!isCurrent()) return;
        await recordTelemetry(deps, captured, effective, delivered, Date.now() - started, {
          invoked: handle !== undefined || decision.advisorInvocations === 1,
          latencyMs:
            handle !== undefined ? Date.now() - advisorStartedAt : decision.advisorLatencyMs,
        });
      } catch {
        return;
      } finally {
        if (grant) deps.history?.release(grant);
      }
    } finally {
      token.release();
    }
  });
  return {
    dispose: async () => {
      disposed = true;
      if (ownsOperations) operations.dispose();
      await registration.dispose();
    },
    forget: (sessionID) => {
      operations.forget(sessionID);
      domain.forget(sessionID);
    },
    markReviewed: (sessionID, turnKey, entries) => {
      domain.markReviewed(sessionID, turnKey, entries);
    },
  };
}

async function prepareAutomatic(
  deps: RoutingObserverDeps,
  sessionID: SessionID,
  hold: (reservation: AdviceReservation) => void,
): Promise<AutomaticPreparation> {
  if (deps.history === undefined) {
    return { ready: false, skipReason: ADVISOR_HISTORY_UNAVAILABLE_SKIP_REASON };
  }
  try {
    const reservation = await deps.history.reserve(sessionID);
    if (reservation === undefined) {
      return { ready: false, skipReason: ADVISOR_HISTORY_CAPACITY_SKIP_REASON };
    }
    hold(reservation);
    return { ready: true };
  } catch {
    return { ready: false, skipReason: ADVISOR_HISTORY_UNAVAILABLE_SKIP_REASON };
  }
}

async function loadRetained(
  deps: RoutingObserverDeps,
  sessionID: SessionID,
): Promise<readonly AdviceRecord[]> {
  if (deps.history === undefined) return [];
  try {
    return await deps.history.get(sessionID);
  } catch {
    return [];
  }
}

function visibleRetained(
  deps: RoutingObserverDeps,
  sessionID: SessionID,
  records: readonly AdviceRecord[],
): readonly AdviceRecord[] {
  const absorbed = deps.absorbed?.(sessionID);
  if (absorbed === undefined || absorbed.size === 0) return records;
  return records.filter((record) => !absorbed.has(record.id));
}

async function commitAdvice(
  deps: RoutingObserverDeps,
  grant: AdviceReservation | undefined,
  captured: CapturedRequest,
  decision: RoutingDecision,
): Promise<AdviceRecord | undefined> {
  if (grant === undefined || deps.history === undefined || decision.advice === undefined) {
    return undefined;
  }
  try {
    return await deps.history.commit(grant, {
      turnKey: captured.turnKey,
      materialFingerprint: decision.fingerprint ?? "",
      advice: decision.advice,
    });
  } catch {
    return undefined;
  }
}

function persistenceFailure(decision: RoutingDecision): RoutingDecision {
  return {
    ...decision,
    action: "fail",
    error: "automatic advice persistence failed",
    failure: { errorClass: ADVISOR_PERSISTENCE_ERROR_CLASS, disposition: "terminal" },
    advisorOutcome: "failed",
  };
}

function injectRetained(
  deps: RoutingObserverDeps,
  dispatch: AssembledRequest,
  owned: WeakSet<object>,
  injected: WeakSet<object>,
  records: readonly AdviceRecord[],
): void {
  if (records.length === 0) return;
  if (injected.has(dispatch)) return;
  const system = dispatch.system;
  if (!Array.isArray(system)) return;
  const before = system.length;
  try {
    (deps.deliverRetained ?? deliverRetainedReviews)({ system, records });
  } catch {
    return;
  }
  ownAppended(system, before, owned);
  injected.add(dispatch);
}

function finishLifecycle(
  deps: RoutingObserverDeps,
  handle: ReviewHandle | undefined,
  decision: RoutingDecision,
  delivered: boolean | undefined,
): void {
  if (handle === undefined || deps.lifecycle === undefined) return;
  try {
    if (decision.action === "accept" && delivered === true && decision.advice !== undefined) {
      deps.lifecycle.finish(handle, "completed", decision.advice);
      return;
    }
    deps.lifecycle.finish(handle, decision.advisorTimedOut === true ? "timeout" : "failed");
  } catch {
    return;
  }
}

function advertisesAdvisor(dispatch: object): boolean {
  const tools = (dispatch as { readonly tools?: unknown }).tools;
  return typeof tools === "object" && tools !== null && Object.hasOwn(tools, ADVISOR_TOOL_NAME);
}

function removeAdvisorTool(dispatch: object): void {
  const tools = (dispatch as { readonly tools?: unknown }).tools;
  if (typeof tools !== "object" || tools === null) return;
  try {
    delete (tools as Record<string, unknown>)[ADVISOR_TOOL_NAME];
  } catch {
    return;
  }
}

function canonicalRequest(
  dispatch: AssembledRequest,
  ownedGuidance: WeakSet<object>,
  ownedDelivery: WeakSet<object>,
): AssembledRequest {
  const system = dispatch.system;
  if (!Array.isArray(system)) return dispatch;
  const owned = (part: object) => ownedGuidance.has(part) || ownedDelivery.has(part);
  if (!system.some(owned)) return dispatch;
  return { ...dispatch, system: system.filter((part) => !owned(part)) };
}

function injectGuidance(dispatch: AssembledRequest, ownedGuidance: WeakSet<object>): void {
  const system = dispatch.system;
  if (!Array.isArray(system) || system.some((part) => ownedGuidance.has(part))) return;
  const part = { type: "text" as const, text: EXECUTOR_ADVISOR_GUIDANCE };
  try {
    system.push(part);
  } catch {
    return;
  }
  ownedGuidance.add(part);
}

function readSessionID(dispatch: object): string | undefined {
  const value = (dispatch as { readonly sessionID?: unknown }).sessionID;
  return typeof value === "string" ? value : undefined;
}

function readAgent(dispatch: object): string | undefined {
  const value = (dispatch as { readonly agent?: unknown }).agent;
  return typeof value === "string" ? value : undefined;
}

function deliverAccepted(
  deps: RoutingObserverDeps,
  dispatch: AssembledRequest,
  owned: WeakSet<object>,
  decision: RoutingDecision,
): boolean | undefined {
  if (decision.action !== "accept" || decision.mode !== "active") return undefined;
  if (decision.advice === undefined) return undefined;
  const system = dispatch.system;
  if (!Array.isArray(system)) return false;
  const before = system.length;
  try {
    (deps.deliver ?? deliverAdvice)({ system, advice: decision.advice });
  } catch {
    return false;
  }
  ownAppended(system, before, owned);
  return true;
}

function ownAppended(system: readonly object[], before: number, owned: WeakSet<object>): void {
  for (let index = before; index < system.length; index += 1) {
    owned.add(system[index]);
  }
}

async function recordTelemetry(
  deps: RoutingObserverDeps,
  captured: CapturedRequest,
  decision: RoutingDecision,
  delivered: boolean | undefined,
  latencyMs: number,
  advisor: { readonly invoked: boolean; readonly latencyMs?: number },
): Promise<void> {
  if (deps.telemetry === undefined || decision.mode === undefined) return;
  if (decision.mode === "off") return;
  const model = decision.failure?.model ?? metadataString(decision, "model");
  const attempts = decision.failure?.attempts ?? metadataNumber(decision, "attempts");
  const rawConsequence = metadataNumber(decision, "rawConsequence");
  const consequenceProbabilities = metadataNumberRecord(decision, "consequenceProbabilities");
  const consequenceConfidence = metadataNumber(decision, "consequenceConfidence");
  const advisorOutcome = advisor.invoked
    ? (decision.advisorOutcome ?? (decision.action === "accept" ? "completed" : "failed"))
    : undefined;
  const event: TelemetryEventInput = {
    sessionID: captured.sessionID,
    turnKey: captured.turnKey,
    mode: decision.mode,
    decision: decision.action,
    latencyMs,
    ...(decision.fingerprint ? { fingerprint: decision.fingerprint } : {}),
    ...(decision.assessment
      ? {
          advisorWouldHelp: decision.assessment.advisorWouldHelp,
          consequence: decision.assessment.consequence,
        }
      : {}),
    ...(rawConsequence !== undefined ? { rawConsequence } : {}),
    ...(consequenceProbabilities ? { consequenceProbabilities } : {}),
    ...(consequenceConfidence !== undefined ? { consequenceConfidence } : {}),
    ...(decision.policy ? { policy: decision.policy } : {}),
    ...(model ? { model } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(decision.error && decision.action !== "skip"
      ? { errorClass: decision.failure?.errorClass ?? "RouterError" }
      : {}),
    ...(decision.failure?.disposition ? { failureDisposition: decision.failure.disposition } : {}),
    ...(decision.advisorModel ? { advisorModel: decision.advisorModel } : {}),
    ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
    ...(decision.advisorContext ? { advisorContext: decision.advisorContext } : {}),
    ...(decision.mode === "active" ? { advisorInvocations: advisor.invoked ? 1 : 0 } : {}),
    ...(advisor.invoked && advisor.latencyMs !== undefined
      ? { advisorLatencyMs: advisor.latencyMs }
      : {}),
    ...(advisor.invoked && advisorOutcome !== undefined ? { advisorOutcome } : {}),
    ...(advisor.invoked ? { advisorTimedOut: decision.advisorTimedOut === true } : {}),
    ...(delivered !== undefined ? { delivered } : {}),
  };
  await deps.telemetry.record(event);
}

function metadataNumber(decision: RoutingDecision, key: string): number | undefined {
  const value = decision.assessment?.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function metadataNumberRecord(
  decision: RoutingDecision,
  key: string,
): Readonly<Record<string, number>> | undefined {
  const value = decision.assessment?.metadata?.[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function metadataString(decision: RoutingDecision, key: string): string | undefined {
  const value = decision.assessment?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readDispatchKind(dispatch: object): unknown {
  return (dispatch as { readonly kind?: unknown }).kind;
}
