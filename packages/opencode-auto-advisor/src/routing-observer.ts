import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { type AdviceDeliveryInput, type AdviceLifetime, deliverAdvice } from "./advice-delivery.js";
import type { AdvisorProjectionBuilder } from "./advisor-projection.js";
import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig } from "./config.js";
import type { AssembledMessage } from "./messages.js";
import type { ModelLimitResolver } from "./model-limits.js";
import { type CapturedRequest, captureAssembledRequest } from "./request.js";
import { createRoutingDomain } from "./routing.js";
import type { AdvisorRouter, RoutingDecision } from "./routing-types.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { TelemetryEventInput, TelemetrySink } from "./telemetry-types.js";

type ObserverContext = Pick<PluginContext, "session">;

export interface RoutingObserverDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
  readonly snapshots: SnapshotStore;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
  readonly telemetry?: TelemetrySink;
  readonly lifetime?: AdviceLifetime;
  readonly deliver?: (input: AdviceDeliveryInput) => void;
}

export interface RoutingObserverRegistration {
  readonly dispose: () => Promise<void>;
  readonly forget: (sessionID: CapturedRequest["sessionID"]) => void;
}

export async function registerRoutingObserver(
  context: ObserverContext,
  deps: RoutingObserverDeps,
): Promise<RoutingObserverRegistration> {
  const domain = createRoutingDomain(deps);
  const registration = await context.session.hook("context", async (dispatch) => {
    const kind = readDispatchKind(dispatch);
    if (kind !== undefined && kind !== "primary") return;
    let captured: CapturedRequest;
    try {
      captured = captureAssembledRequest(dispatch);
    } catch {
      return;
    }
    try {
      deps.snapshots.capture({
        sessionID: captured.sessionID,
        turnKey: captured.turnKey,
        entries: captured.entries,
        executorModel: captured.executorModel,
      });
      deps.lifetime?.expire(captured.sessionID, captured.turnKey);
      const started = Date.now();
      const decision = await domain.observe({
        sessionID: captured.sessionID,
        ...(kind === "primary" ? { kind } : {}),
        capture: async () => ({
          entries: captured.entries,
          lastUserMessageID: captured.turnKey,
          executorModel: captured.executorModel,
        }),
      });
      const delivered = deliverAccepted(deps, dispatch.messages, captured, decision);
      if (decision.mode === "active") {
        injectLiveAdvice(deps, dispatch.messages, captured, delivered);
      }
      await recordTelemetry(deps, captured, decision, delivered, Date.now() - started);
    } catch {
      return;
    }
  });
  return { dispose: () => registration.dispose(), forget: (sessionID) => domain.forget(sessionID) };
}

function deliverAccepted(
  deps: RoutingObserverDeps,
  messages: AssembledMessage[],
  captured: CapturedRequest,
  decision: RoutingDecision,
): boolean | undefined {
  if (decision.action !== "accept" || decision.mode !== "active") return undefined;
  if (decision.advice === undefined) return undefined;
  try {
    (deps.deliver ?? deliverAdvice)({ messages, advice: decision.advice });
    deps.lifetime?.activate(captured.sessionID, captured.turnKey, decision.advice);
    return true;
  } catch {
    return false;
  }
}

function injectLiveAdvice(
  deps: RoutingObserverDeps,
  messages: AssembledMessage[],
  captured: CapturedRequest,
  delivered: boolean | undefined,
): void {
  if (delivered === true) return;
  const live = deps.lifetime?.current(captured.sessionID);
  if (live === undefined || live.turnKey !== captured.turnKey) return;
  try {
    (deps.deliver ?? deliverAdvice)({ messages, advice: live.text });
  } catch {
    return;
  }
}

async function recordTelemetry(
  deps: RoutingObserverDeps,
  captured: CapturedRequest,
  decision: RoutingDecision,
  delivered: boolean | undefined,
  latencyMs: number,
): Promise<void> {
  if (deps.telemetry === undefined || decision.mode === undefined) return;
  if (decision.mode === "off") return;
  const model = decision.failure?.model ?? metadataString(decision, "model");
  const attempts = decision.failure?.attempts ?? metadataNumber(decision, "attempts");
  const rawConsequence = metadataNumber(decision, "rawConsequence");
  const consequenceProbabilities = metadataNumberRecord(decision, "consequenceProbabilities");
  const consequenceConfidence = metadataNumber(decision, "consequenceConfidence");
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
