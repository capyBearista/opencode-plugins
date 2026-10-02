import {
  ADVISOR_PERMISSION_ACTION,
  deniesWholeSession,
  type PermissionRule,
} from "./permission-match.js";

export interface EligibilitySessionInfo {
  readonly parentID?: string;
  readonly permissions?: readonly PermissionRule[];
}

export interface EligibilityAgentInfo {
  readonly permissions?: readonly PermissionRule[];
}

export interface EligibilitySources {
  readonly session: {
    readonly get?: (input: never) => Promise<EligibilitySessionInfo | undefined>;
  };
  readonly agent?: {
    readonly get?: (input: never) => Promise<{ readonly data?: EligibilityAgentInfo } | undefined>;
  };
}

export interface EligibilityInput {
  readonly sessionID: string;
  readonly agentID?: string;
}

export type EligibilityFailureKind = "parented" | "denied" | "unavailable";

export type EligibilityDecision =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly kind: EligibilityFailureKind;
      readonly reason: string;
    };

export async function evaluateAdvisorEligibility(
  sources: EligibilitySources,
  input: EligibilityInput,
): Promise<EligibilityDecision> {
  const sessionGet = sources.session.get;
  if (typeof sessionGet !== "function")
    return ineligible("unavailable", "session lookup is unavailable");

  let session: EligibilitySessionInfo | undefined;
  try {
    session = await sessionGet.call(sources.session, { sessionID: input.sessionID } as never);
  } catch {
    return ineligible("unavailable", "session lookup failed");
  }
  if (session === undefined) return ineligible("unavailable", "session not found");
  if (session.parentID !== undefined)
    return ineligible("parented", "parented sessions are not eligible");

  const agentGet = sources.agent?.get;
  if (input.agentID === undefined || typeof agentGet !== "function")
    return ineligible("unavailable", "agent lookup is unavailable");

  let agent: { readonly data?: EligibilityAgentInfo } | undefined;
  try {
    agent = await agentGet.call(sources.agent, { agentID: input.agentID } as never);
  } catch {
    return ineligible("unavailable", "agent lookup failed");
  }
  if (agent?.data === undefined) return ineligible("unavailable", "agent not found");

  const permissions = [...(agent.data.permissions ?? []), ...(session.permissions ?? [])];
  if (deniesWholeSession(ADVISOR_PERMISSION_ACTION, permissions))
    return ineligible("denied", "advisor permission is denied for this session");

  return { eligible: true };
}

function ineligible(kind: EligibilityFailureKind, reason: string): EligibilityDecision {
  return { eligible: false, kind, reason };
}
