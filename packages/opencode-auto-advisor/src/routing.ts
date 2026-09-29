import type { AdvisorService } from "./advisor-service.js";
import type { AdvisorConfig, RoutingConfig } from "./config.js";
import { fingerprintPreimage, routingFingerprint } from "./fingerprint.js";
import type { SessionID } from "./messages.js";
import { normalizeAssessment } from "./router.js";
import type {
  AdvisorRouter,
  DispatchKind,
  NormalizedAssessment,
  RoutingDecision,
  RoutingOpportunity,
} from "./routing-types.js";
import { serializeAdvisorContext } from "./serialize.js";

export interface RoutingDomainDeps {
  readonly loadConfig: () => Promise<AdvisorConfig>;
  readonly router: AdvisorRouter;
  readonly service: AdvisorService;
}

export interface RoutingDomain {
  readonly observe: (opportunity: RoutingOpportunity) => Promise<RoutingDecision>;
}

interface TurnState {
  readonly userMessageID: string;
  fingerprint?: string;
  consumed: number;
}

export function createRoutingDomain(deps: RoutingDomainDeps): RoutingDomain {
  const turns = new Map<SessionID, TurnState>();

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

      let captured: Awaited<ReturnType<RoutingOpportunity["capture"]>>;
      try {
        captured = await opportunity.capture();
      } catch (cause) {
        return { action: "fail", mode, error: describe(cause) };
      }

      const fingerprint = routingFingerprint(captured.entries);
      const turn = turnFor(turns, opportunity.sessionID, captured.lastUserMessageID);
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
        return { action: "fail", mode, fingerprint, error: describe(cause) };
      }

      if (!acceptsConsultation(config.routing, assessment)) {
        return { action: "reject", mode, fingerprint, assessment };
      }
      if (turn.consumed >= config.routing.maxConsultationsPerTurn) {
        return { action: "deny", mode, fingerprint, assessment };
      }
      turn.consumed += 1;
      if (mode === "observe") return { action: "accept", mode, fingerprint, assessment };

      try {
        const consultation = await deps.service.consult({
          transcript: serializeAdvisorContext(captured.entries),
          ...(captured.executorModel ? { executorModel: captured.executorModel } : {}),
        });
        return { action: "accept", mode, fingerprint, assessment, advice: consultation.advice };
      } catch (cause) {
        return { action: "fail", mode, fingerprint, assessment, error: describe(cause) };
      }
    },
  };
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

function turnFor(
  turns: Map<SessionID, TurnState>,
  sessionID: SessionID,
  userMessageID: string,
): TurnState {
  const existing = turns.get(sessionID);
  if (existing && existing.userMessageID === userMessageID) return existing;
  const next: TurnState = { userMessageID, consumed: 0 };
  turns.set(sessionID, next);
  return next;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
