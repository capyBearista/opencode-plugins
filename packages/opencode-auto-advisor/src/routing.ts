import {
  type AdvisorProjection,
  type AdvisorProjectionBuilder,
  buildAdvisorProjection,
} from "./advisor-projection.js";
import {
  AdvisorInvalidatedError,
  type AdvisorService,
  AdvisorTimeoutError,
  resolveAdvisorModel,
} from "./advisor-service.js";
import type { CanonicalState } from "./canonical.js";
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
export const ADVISOR_PROJECTION_SKIP_REASON = "advisor-projection-unusable";
export const ADVISOR_OPERATION_INVALIDATED_SKIP_REASON = "advisor-operation-invalidated";
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
  readonly markReviewed: (sessionID: SessionID, turnKey: string, entries: CanonicalState) => void;
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
      const isCurrent = opportunity.isCurrent ?? (() => true);
      let config: AdvisorConfig;
      try {
        config = await deps.loadConfig();
      } catch (cause) {
        return { action: "fail", error: describe(cause) };
      }
      const mode = config.routing.mode;
      const invalidated = (extra: Partial<RoutingDecision> = {}): RoutingDecision => ({
        action: "skip",
        mode,
        skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
        ...extra,
      });
      if (!isCurrent()) return invalidated();
      if (mode === "off") return { action: "skip", mode };
      if (!isPrimaryDispatch(opportunity.kind)) return { action: "skip", mode };
      const policy = policySnapshot(config.routing);

      let captured: Awaited<ReturnType<RoutingOpportunity["capture"]>>;
      try {
        captured = await opportunity.capture(mode);
      } catch (cause) {
        if (!isCurrent()) return invalidated({ policy });
        return { action: "fail", mode, policy, error: describe(cause) };
      }
      if (!isCurrent()) return invalidated({ policy });

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
        if (!isCurrent()) return invalidated({ fingerprint, policy });
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
      if (!isCurrent()) return invalidated({ fingerprint, policy });

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
      if (!isCurrent()) return invalidated({ fingerprint, assessment, policy });
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

      let projection: AdvisorProjection;
      try {
        const projectionEntries =
          captured.advisorEntries && captured.advisorEntries.length > 0
            ? [...captured.entries, ...captured.advisorEntries]
            : captured.entries;
        projection = project(projectionEntries, { inputBudget });
      } catch (cause) {
        return {
          action: "skip",
          mode,
          fingerprint,
          assessment,
          policy,
          skipReason: ADVISOR_PROJECTION_SKIP_REASON,
          error: describe(cause),
        };
      }

      if (!isCurrent()) return invalidated({ fingerprint, assessment, policy });

      turn.consumed += 1;
      const advisorContext = projection.diagnostics;
      const advisorStartedAt = Date.now();
      try {
        const consultation = await deps.service.consult({
          transcript: projection.transcript,
          ...(advisorModel ? { advisorModel } : {}),
          ...(captured.executorModel ? { executorModel: captured.executorModel } : {}),
          ...(opportunity.onAdvisorStart ? { onStart: opportunity.onAdvisorStart } : {}),
          ...(opportunity.isCurrent ? { isCurrent: opportunity.isCurrent } : {}),
        });
        if (!isCurrent()) return invalidated({ fingerprint, assessment, policy });
        return {
          action: "accept",
          mode,
          fingerprint,
          assessment,
          policy,
          advice: consultation.advice,
          ...(consultation.model ? { advisorModel: refKey(consultation.model) } : {}),
          ...(advisorContext ? { advisorContext } : {}),
          advisorInvocations: 1,
          advisorLatencyMs: Date.now() - advisorStartedAt,
          advisorOutcome: "completed",
          advisorTimedOut: false,
        };
      } catch (cause) {
        if (cause instanceof AdvisorInvalidatedError) {
          return invalidated({ fingerprint, assessment, policy });
        }
        const timedOut = cause instanceof AdvisorTimeoutError;
        return {
          action: "fail",
          mode,
          fingerprint,
          assessment,
          policy,
          error: describe(cause),
          failure: { errorClass: ADVISOR_CONSULT_ERROR_CLASS, disposition: "terminal" },
          ...(advisorContext ? { advisorContext } : {}),
          advisorInvocations: 1,
          advisorLatencyMs: Date.now() - advisorStartedAt,
          advisorOutcome: timedOut ? "timeout" : "failed",
          advisorTimedOut: timedOut,
        };
      }
    },
    forget: (sessionID) => {
      turns.forget(sessionID);
      deps.router.forget?.(sessionID);
    },
    markReviewed: (sessionID, turnKey, entries) => {
      turns.turnFor(sessionID, turnKey).fingerprint = routingFingerprint(entries);
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
