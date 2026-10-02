import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import {
  type AdviceDeliveryInput,
  deliverAdvice,
  deliverRetainedReview,
  type RetainedReviewDeliveryInput,
} from "./advice-delivery.js";
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
import {
  RETAINED_REVIEW_OVERSIZE_SKIP_REASON,
  type RetainedReview,
  type RetainedReviewStore,
  type RetainedReviewWrite,
  retainedReviewEntry,
} from "./retained-review.js";
import type { ReviewHandle, ReviewLifecycle } from "./review-lifecycle.js";
import { createRoutingDomain } from "./routing.js";
import type { AdvisorRouter, RoutingDecision } from "./routing-types.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { TelemetryEventInput, TelemetrySink } from "./telemetry-types.js";

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
  readonly retained?: RetainedReviewStore;
  readonly lifecycle?: ReviewLifecycle;
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

      let retained: RetainedReview | undefined;
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
            const entry = retainedReviewEntry(retained);
            return {
              entries: captured.entries,
              lastUserMessageID: captured.turnKey,
              executorModel: captured.executorModel,
              ...(entry ? { advisorEntries: [entry] } : {}),
            };
          },
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
        if (decision.mode === "active") {
          injectRetained(deps, dispatch, ownedDelivery, retainedInjected, retained);
        }
        let effective = decision;
        if (accepted && decision.advice !== undefined) {
          const retention = await retainAdvice(
            deps,
            captured.sessionID,
            captured.turnKey,
            decision.advice,
          );
          if (!isCurrent()) return;
          if (retention?.stored === false && retention.reason === "oversize") {
            // Advice is still delivered in full; skipReason is the debug
            // diagnostic that records the retention skip on an accepted event.
            effective = { ...decision, skipReason: RETAINED_REVIEW_OVERSIZE_SKIP_REASON };
          }
        }
        const delivered = deliverAccepted(deps, dispatch, ownedDelivery, effective);
        finishLifecycle(deps, handle, effective, delivered);
        if (!isCurrent()) return;
        await recordTelemetry(deps, captured, effective, delivered, Date.now() - started, {
          invoked: handle !== undefined || decision.advisorInvocations === 1,
          latencyMs:
            handle !== undefined ? Date.now() - advisorStartedAt : decision.advisorLatencyMs,
        });
      } catch {
        return;
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

async function loadRetained(
  deps: RoutingObserverDeps,
  sessionID: SessionID,
): Promise<RetainedReview | undefined> {
  if (deps.retained === undefined) return undefined;
  try {
    return await deps.retained.read(sessionID);
  } catch {
    return undefined;
  }
}

async function retainAdvice(
  deps: RoutingObserverDeps,
  sessionID: SessionID,
  turnKey: string,
  advice: string,
): Promise<RetainedReviewWrite | undefined> {
  if (deps.retained === undefined) return undefined;
  try {
    return await deps.retained.write(sessionID, { advice, turnKey });
  } catch {
    return undefined;
  }
}

function injectRetained(
  deps: RoutingObserverDeps,
  dispatch: AssembledRequest,
  owned: WeakSet<object>,
  injected: WeakSet<object>,
  review: RetainedReview | undefined,
): void {
  if (review === undefined) return;
  if (injected.has(dispatch)) return;
  const system = dispatch.system;
  if (!Array.isArray(system)) return;
  const before = system.length;
  try {
    (deps.deliverRetained ?? deliverRetainedReview)({ system, review });
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
