import type { AdvisorContextDiagnostics } from "./advisor-projection.js";
import type { CanonicalState } from "./canonical.js";
import type { RoutingMode } from "./config.js";
import type { ModelReference, SessionID } from "./messages.js";

export type DispatchKind = "primary" | "compaction" | "title" | "generate";

export interface RouterAssessment {
  readonly advisorWouldHelp: number;
  readonly consequence: number;
  readonly metadata?: Record<string, unknown>;
}

export interface NormalizedAssessment {
  readonly advisorWouldHelp: number;
  readonly consequence: number;
  readonly metadata?: Record<string, unknown>;
}

export interface RoutingState {
  readonly sessionID: SessionID;
  readonly entries: CanonicalState;
}

export interface AdvisorRouter {
  readonly evaluate: (state: RoutingState) => Promise<RouterAssessment>;
  readonly forget?: (sessionID: SessionID) => void;
}

export interface RoutingStateCapture {
  readonly entries: CanonicalState;
  readonly lastUserMessageID: string;
  readonly executorModel?: ModelReference;
}

export interface RoutingOpportunity {
  readonly sessionID: SessionID;
  readonly kind?: DispatchKind;
  readonly capture: () => Promise<RoutingStateCapture>;
}

export type RoutingAction = "skip" | "suppress" | "deny" | "reject" | "accept" | "fail";

export type RoutingFailureDisposition = "retry" | "fallback" | "terminal";

export interface RoutingFailure {
  readonly errorClass: string;
  readonly model?: string;
  readonly attempts?: number;
  readonly disposition?: RoutingFailureDisposition;
}

export interface RoutingPolicySnapshot {
  readonly advisorWouldHelpThreshold: number;
  readonly consequenceThreshold: number;
}

export interface RoutingDecision {
  readonly action: RoutingAction;
  readonly mode?: RoutingMode;
  readonly fingerprint?: string;
  readonly assessment?: NormalizedAssessment;
  readonly advice?: string;
  readonly advisorModel?: string;
  readonly advisorContext?: AdvisorContextDiagnostics;
  readonly failure?: RoutingFailure;
  readonly policy?: RoutingPolicySnapshot;
  readonly skipReason?: string;
  readonly error?: string;
}

export const CONSEQUENCE_MIN = 0;
export const CONSEQUENCE_MAX = 4;

export const CONSEQUENCE_ANCHORS = [
  {
    level: 0,
    summary: "trivial",
    guidance: "No meaningful consequence; proceeding without review costs nothing.",
  },
  {
    level: 1,
    summary: "minor",
    guidance: "A minor inconvenience that is easily reversed.",
  },
  {
    level: 2,
    summary: "moderate",
    guidance: "Moderate rework or a mistake visible to the user.",
  },
  {
    level: 3,
    summary: "serious",
    guidance: "Data loss risk, security-relevant, or hard-to-reverse production impact.",
  },
  {
    level: 4,
    summary: "critical",
    guidance: "Irreversible harm with a wide blast radius.",
  },
] as const;
