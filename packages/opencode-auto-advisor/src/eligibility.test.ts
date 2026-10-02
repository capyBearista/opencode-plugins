import { describe, expect, test } from "bun:test";
import {
  type EligibilitySessionInfo,
  type EligibilitySources,
  evaluateAdvisorEligibility,
} from "./eligibility.js";

function sources(session?: EligibilitySources["session"]["get"]): EligibilitySources {
  return { session: { ...(session ? { get: session } : {}) } };
}

const rootSession = async (): Promise<EligibilitySessionInfo> => ({});

describe("evaluateAdvisorEligibility", () => {
  test("admits a root session", async () => {
    const decision = await evaluateAdvisorEligibility(sources(rootSession), {
      sessionID: "ses_root",
    });
    expect(decision).toEqual({ eligible: true });
  });

  test("excludes a parented session", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources(async () => ({ parentID: "ses_parent" })),
      { sessionID: "ses_child" },
    );
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.kind).toBe("parented");
      expect(decision.reason).toContain("parented");
    }
  });

  test("reports unavailable when the session lookup is missing or fails", async () => {
    const missing = await evaluateAdvisorEligibility(sources(), {
      sessionID: "ses_root",
    });
    expect(missing.eligible).toBe(false);
    if (!missing.eligible) expect(missing.kind).toBe("unavailable");

    const failed = await evaluateAdvisorEligibility(
      sources(async () => {
        throw new Error("session store down");
      }),
      { sessionID: "ses_root" },
    );
    expect(failed.eligible).toBe(false);
    if (!failed.eligible) expect(failed.reason).toContain("session lookup failed");
  });

  test("reports unavailable when the session is not found", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources(async () => undefined),
      { sessionID: "ses_root" },
    );
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) expect(decision.kind).toBe("unavailable");
  });
});
