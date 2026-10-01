import {
  type AdvisorContextDiagnostics,
  type AdvisorProjectionBuilder,
  buildAdvisorProjection,
} from "./advisor-projection.js";
import { type AdvisorService, resolveAdvisorModel } from "./advisor-service.js";
import type { AdvisorConfig, RoutingConfig } from "./config.js";
import { routingFingerprint } from "./fingerprint.js";
import type { ModelReference, SessionID } from "./messages.js";
import { computeInputBudget, type ModelLimitResolver, type ModelLimits } from "./model-limits.js";
import { normalizeAssessment, RouterError } from "./router.js";
import type {
  AdvisorRouter,
  DispatchKind,
  NormalizedAssessment,
  RoutingDecision,
  RoutingFailure,
  RoutingOpportunity,
  RoutingPolicySnapshot,
} from "./routing-types.js";
import { refKey } from "./serialize-assistant.js";
import { createTurnStore } from "./turn-store.js";

export const ADVISOR_LIMITS_SKIP_REASON = "advisor-model-limits-unavailable";
export const ADVISOR_CONSULT_ERROR_CLASS = "ConsultationError";

export interface RoutingDomainDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
}

export interface RoutingDomain {
  readonly observe: (opportunity: RoutingOpportunity) => Promise<RoutingDecision>;
  readonly forget: (sessionID: SessionID) => void;
}

export function createRoutingDomain(
  deps: RoutingDomainDeps,
  options: { readonly maxSessions?: number } = {},
): RoutingDomain {
  const turns = createTurnStore(options);
  const project = deps.project ?? buildAdvisorProjection;
  const resolveLimits = deps.resolveLimits ?? (async () => undefined);

  return {
    observe: async (opportunity) => {
      let config: AdvisorConfig;
      try {
        config = await deps.loadConfig();
      } catch (cause) {
        return { action: "fail", error: describe(cause) };
      }
      const mode = config.routing.mode;
      if (mode === "off") return { action: "skip", mode };
      if (!isPrimaryDispatch(opportunity.kind)) return { action: "skip", mode };
      const policy = policySnapshot(config.routing);

      let captured: Awaited<ReturnType<RoutingOpportunity["capture"]>>;
      try {
        captured = await opportunity.capture();
      } catch (cause) {
        return { action: "fail", mode, policy, error: describe(cause) };
      }

      const fingerprint = routingFingerprint(captured.entries);
      const turn = turns.turnFor(opportunity.sessionID, captured.lastUserMessageID);
      if (turn.fingerprint === fingerprint) return { action: "suppress", mode, fingerprint };
      turn.fingerprint = fingerprint;

      if (mode === "active" && turn.consumed >= config.routing.maxConsultationsPerTurn) {
        return { action: "deny", mode, fingerprint, policy };
      }

      let assessment: NormalizedAssessment;
      try {
        assessment = normalizeAssessment(
          await deps.router.evaluate({
            sessionID: opportunity.sessionID,
            entries: captured.entries,
          }),
        );
      } catch (cause) {
        const failure = failureOf(cause);
        return {
          action: "fail",
          mode,
          fingerprint,
          policy,
          error: describe(cause),
          ...(failure ? { failure } : {}),
        };
      }

      if (!acceptsConsultation(config.routing, assessment)) {
        return { action: "reject", mode, fingerprint, assessment, policy };
      }
      if (turn.consumed >= config.routing.maxConsultationsPerTurn) {
        return { action: "deny", mode, fingerprint, assessment, policy };
      }
      if (mode === "observe") {
        turn.consumed += 1;
        return { action: "accept", mode, fingerprint, assessment, policy };
      }

      const advisorModel = resolveAdvisorModel(config, captured.executorModel);
      const limits = await resolveLimitsSafely(resolveLimits, advisorModel);
      const inputBudget = limits === undefined ? undefined : computeInputBudget(limits);
      if (inputBudget === undefined) {
        return {
          action: "skip",
          mode,
          fingerprint,
          assessment,
          policy,
          skipReason: ADVISOR_LIMITS_SKIP_REASON,
          error: `advisor model limits unavailable${advisorModel ? ` for ${refKey(advisorModel)}` : ""}`,
        };
      }

      turn.consumed += 1;
      let advisorContext: AdvisorContextDiagnostics | undefined;
      try {
        const projection = project(captured.entries, { inputBudget });
        advisorContext = projection.diagnostics;
        const consultation = await deps.service.consult({
          transcript: projection.transcript,
          ...(captured.executorModel ? { executorModel: captured.executorModel } : {}),
        });
        return {
          action: "accept",
          mode,
          fingerprint,
          assessment,
          policy,
          advice: consultation.advice,
          ...(consultation.model ? { advisorModel: refKey(consultation.model) } : {}),
          ...(advisorContext ? { advisorContext } : {}),
        };
      } catch (cause) {
        return {
          action: "fail",
          mode,
          fingerprint,
          assessment,
          policy,
          error: describe(cause),
          failure: { errorClass: ADVISOR_CONSULT_ERROR_CLASS, disposition: "terminal" },
          ...(advisorContext ? { advisorContext } : {}),
        };
      }
    },
    forget: (sessionID) => {
      turns.forget(sessionID);
      deps.router.forget?.(sessionID);
    },
  };
}

async function resolveLimitsSafely(
  resolveLimits: ModelLimitResolver,
  model: ModelReference | undefined,
): Promise<ModelLimits | undefined> {
  if (model === undefined) return undefined;
  try {
    return await resolveLimits(model);
  } catch {
    return undefined;
  }
}

function policySnapshot(routing: RoutingConfig): RoutingPolicySnapshot {
  return {
    advisorWouldHelpThreshold: routing.advisorWouldHelpThreshold,
    consequenceThreshold: routing.consequenceThreshold,
  };
}

function failureOf(cause: unknown): RoutingFailure | undefined {
  return cause instanceof RouterError ? cause.failure : undefined;
}

export function acceptsConsultation(
  routing: RoutingConfig,
  assessment: NormalizedAssessment,
): boolean {
  return (
    assessment.advisorWouldHelp >= routing.advisorWouldHelpThreshold &&
    assessment.consequence >= routing.consequenceThreshold
  );
}

export function isPrimaryDispatch(kind: DispatchKind | undefined): boolean {
  return kind === undefined || kind === "primary";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
