import { describe, expect, test } from "bun:test";
import {
  type EligibilitySessionInfo,
  type EligibilitySources,
  evaluateAdvisorEligibility,
} from "./eligibility.js";
import type { PermissionRule } from "./permission-match.js";

const rule = (
  action: string,
  resource: string,
  effect: PermissionRule["effect"],
): PermissionRule => ({
  action,
  resource,
  effect,
});

function sources(options: {
  readonly session?: EligibilitySources["session"]["get"];
  readonly agent?: NonNullable<EligibilitySources["agent"]>["get"];
}): EligibilitySources {
  return {
    session: { ...(options.session ? { get: options.session } : {}) },
    ...(options.agent ? { agent: { get: options.agent } } : {}),
  };
}

const rootSession = async (): Promise<EligibilitySessionInfo> => ({ permissions: [] });
const openAgent = async () => ({ data: { permissions: [] } });

describe("evaluateAdvisorEligibility", () => {
  test("admits a root session with no configured denial", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({ session: rootSession, agent: openAgent }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision).toEqual({ eligible: true });
  });

  test("excludes a parented session", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({
        session: async () => ({ parentID: "ses_parent", permissions: [] }),
        agent: openAgent,
      }),
      { sessionID: "ses_child", agentID: "build" },
    );
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.kind).toBe("parented");
      expect(decision.reason).toContain("parented");
    }
  });

  test("fails closed when the session lookup is missing or fails", async () => {
    const missing = await evaluateAdvisorEligibility(sources({ agent: openAgent }), {
      sessionID: "ses_root",
      agentID: "build",
    });
    expect(missing.eligible).toBe(false);
    if (!missing.eligible) expect(missing.kind).toBe("unavailable");

    const failed = await evaluateAdvisorEligibility(
      sources({
        session: async () => {
          throw new Error("session store down");
        },
        agent: openAgent,
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(failed.eligible).toBe(false);
    if (!failed.eligible) expect(failed.reason).toContain("session lookup failed");
  });

  test("fails closed when the session is not found", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({ session: async () => undefined, agent: openAgent }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision.eligible).toBe(false);
  });

  test("fails closed when the agent lookup is missing, fails, or has no data", async () => {
    const missing = await evaluateAdvisorEligibility(sources({ session: rootSession }), {
      sessionID: "ses_root",
      agentID: "build",
    });
    expect(missing.eligible).toBe(false);

    const failed = await evaluateAdvisorEligibility(
      sources({
        session: rootSession,
        agent: async () => {
          throw new Error("agent store down");
        },
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(failed.eligible).toBe(false);
    if (!failed.eligible) expect(failed.reason).toContain("agent lookup failed");

    const empty = await evaluateAdvisorEligibility(
      sources({ session: rootSession, agent: async () => ({ data: undefined }) }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(empty.eligible).toBe(false);
  });

  test("denies the session when the agent permissions deny the whole-session resource", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({
        session: rootSession,
        agent: async () => ({ data: { permissions: [rule("advisor", "*", "deny")] } }),
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision.eligible).toBe(false);
    if (!decision.eligible) {
      expect(decision.kind).toBe("denied");
      expect(decision.reason).toContain("permission");
    }
  });

  test("denies the advertised-tool trap where a scoped allow follows a broad deny", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({
        session: rootSession,
        agent: async () => ({
          data: { permissions: [rule("advisor", "*", "deny"), rule("advisor", "src/*", "allow")] },
        }),
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision.eligible).toBe(false);
  });

  test("lets session permissions deny even when the agent allows", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({
        session: async () => ({ permissions: [rule("advisor", "*", "deny")] }),
        agent: openAgent,
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision.eligible).toBe(false);
  });

  test("does not deny on ask rules", async () => {
    const decision = await evaluateAdvisorEligibility(
      sources({
        session: rootSession,
        agent: async () => ({ data: { permissions: [rule("advisor", "*", "ask")] } }),
      }),
      { sessionID: "ses_root", agentID: "build" },
    );
    expect(decision).toEqual({ eligible: true });
  });
});
