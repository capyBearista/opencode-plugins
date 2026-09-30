import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig, RoutingConfig } from "./config.js";
import { fingerprintPreimage, routingFingerprint } from "./fingerprint.js";
import type { SessionID } from "./messages.js";
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
import { serializeAdvisorContext } from "./serialize.js";
import { refKey } from "./serialize-assistant.js";
import { createTurnStore } from "./turn-store.js";

export interface RoutingDomainDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
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

      let assessment: NormalizedAssessment;
      try {
        assessment = normalizeAssessment(
          await deps.router.evaluate({
            sessionID: opportunity.sessionID,
            entries: fingerprintPreimage(captured.entries),
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
      turn.consumed += 1;
      if (mode === "observe") return { action: "accept", mode, fingerprint, assessment, policy };

      try {
        const consultation = await deps.service.consult({
          transcript: serializeAdvisorContext(captured.entries),
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
        };
      } catch (cause) {
        return { action: "fail", mode, fingerprint, assessment, policy, error: describe(cause) };
      }
    },
    forget: (sessionID) => {
      turns.forget(sessionID);
    },
  };
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
