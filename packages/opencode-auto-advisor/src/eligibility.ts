export interface EligibilitySessionInfo {
  readonly parentID?: string;
}

export interface EligibilitySources {
  readonly session: {
    readonly get?: (input: never) => Promise<EligibilitySessionInfo | undefined>;
  };
}

export interface EligibilityInput {
  readonly sessionID: string;
}

export type EligibilityFailureKind = "parented" | "unavailable";

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

  return { eligible: true };
}

function ineligible(kind: EligibilityFailureKind, reason: string): EligibilityDecision {
  return { eligible: false, kind, reason };
}
