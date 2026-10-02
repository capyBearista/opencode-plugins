import { describe, expect, test } from "bun:test";
import { type AdvisorProjectionBuilder, buildAdvisorProjection } from "./advisor-projection.js";
import {
  type AdvisorConsultationInput,
  type AdvisorConsultationResult,
  AdvisorInvalidatedError,
  type AdvisorService,
  AdvisorTimeoutError,
} from "./advisor-service.js";
import type { AdvisorConfig, RoutingConfig } from "./config.js";
import type { ModelReference, SessionID } from "./messages.js";
import type { ModelLimitResolver, ModelLimits } from "./model-limits.js";
import { RouterError } from "./router.js";
import {
  ADVISOR_CONSULT_ERROR_CLASS,
  ADVISOR_LIMITS_SKIP_REASON,
  ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
  ADVISOR_PROJECTION_SKIP_REASON,
  acceptsConsultation,
  createRoutingDomain,
  isPrimaryDispatch,
} from "./routing.js";
import type {
  AdvisorRouter,
  DispatchKind,
  RouterAssessment,
  RoutingOpportunity,
  RoutingState,
  RoutingStateCapture,
} from "./routing-types.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";

const USER = (text: string): SerializedEntry => ({ role: "user", text });

const ASSISTANT = (inFlight: boolean, blocks: readonly AssistantBlock[]): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks,
});

const RESULT = (value: string): AssistantBlock => ({
  type: "tool-result",
  id: "call_read",
  name: "read",
  text: value,
});

function routingConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    mode: "observe",
    models: ["jev-1.13"],
    advisorWouldHelpThreshold: 0.7,
    consequenceThreshold: 3,
    maxConsultationsPerTurn: 1,
    ...overrides,
  };
}

function configWith(overrides: Partial<RoutingConfig> = {}): AdvisorConfig {
  return { advisor: {}, routing: routingConfig(overrides) };
}

const DEFAULT_EXECUTOR_MODEL: ModelReference = { providerID: "opencode", id: "jev-1.13" };

function stateWith(
  entries: readonly SerializedEntry[],
  lastUserMessageID = "msg-user-1",
  executorModel: ModelReference | undefined = DEFAULT_EXECUTOR_MODEL,
): RoutingStateCapture {
  return { entries, lastUserMessageID, ...(executorModel ? { executorModel } : {}) };
}

function opportunity(
  capture: RoutingStateCapture,
  options: {
    readonly kind?: DispatchKind;
    readonly sessionID?: SessionID;
    readonly onAdvisorStart?: () => void;
    readonly isCurrent?: () => boolean;
  } = {},
) {
  const counts = { captures: 0 };
  const value: RoutingOpportunity = {
    sessionID: options.sessionID ?? ("ses_1" as SessionID),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
    ...(options.onAdvisorStart ? { onAdvisorStart: options.onAdvisorStart } : {}),
    capture: async () => {
      counts.captures += 1;
      return capture;
    },
  };
  return { value, counts };
}

function scripted(answers: readonly (RouterAssessment | Error)[]) {
  const calls: RoutingState[] = [];
  const router: AdvisorRouter = {
    evaluate: async (state) => {
      calls.push(state);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("scripted router has no answers");
      return answer;
    },
  };
  return { router, calls };
}

function countingService(result: AdvisorConsultationResult | Error = { advice: "check it" }) {
  const calls: AdvisorConsultationInput[] = [];
  const service: AdvisorService = {
    consult: async (input) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { service, calls };
}

function domain(options: {
  readonly config?: AdvisorConfig | Error;
  readonly router: AdvisorRouter;
  readonly service?: AdvisorService;
  readonly maxSessions?: number;
  readonly resolveLimits?: ModelLimitResolver;
  readonly project?: AdvisorProjectionBuilder;
}) {
  return createRoutingDomain(
    {
      loadConfig: async () => {
        if (options.config instanceof Error) throw options.config;
        return options.config ?? configWith();
      },
      router: options.router,
      service: options.service ?? { consult: async () => ({ advice: "advice" }) },
      resolveLimits: options.resolveLimits ?? (async () => ({ context: 200_000, output: 32_000 })),
      ...(options.project ? { project: options.project } : {}),
    },
    options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions },
  );
}

describe("routing modes", () => {
  test("off skips without evaluating or capturing", async () => {
    const router = scripted([{ advisorWouldHelp: 1, consequence: 4 }]);
    const advisor = countingService();
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: configWith({ mode: "off" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision).toEqual({ action: "skip", mode: "off" });
    expect(router.calls).toHaveLength(0);
    expect(advisor.calls).toHaveLength(0);
    expect(counts.captures).toBe(0);
  });

  test("observe evaluates and applies policy without consulting the advisor", async () => {
    const router = scripted([{ advisorWouldHelp: 0.8, consequence: 3 }]);
    const advisor = countingService();
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision.action).toBe("accept");
    expect(decision.mode).toBe("observe");
    expect(decision.assessment).toEqual({ advisorWouldHelp: 0.8, consequence: 3 });
    expect(decision.fingerprint).toBeString();
    expect(router.calls).toHaveLength(1);
    expect(advisor.calls).toHaveLength(0);
    expect(counts.captures).toBe(1);
  });

  test("active consults the advisor with the canonical transcript on accept", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService({ advice: "Beware the migration." });
    const { value } = opportunity(stateWith([USER("migrate the schema")]));

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision.action).toBe("accept");
    expect(decision.mode).toBe("active");
    expect(decision.advice).toBe("Beware the migration.");
    expect(advisor.calls).toHaveLength(1);
    expect(advisor.calls[0]?.transcript).toContain("migrate the schema");
  });
});

describe("opportunity gating", () => {
  test("evaluates primary dispatches, including payloads without kind", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });

    const withKind = await routing.observe(
      opportunity(stateWith([USER("hi")]), { kind: "primary" }).value,
    );
    const withoutKind = await routing.observe(
      opportunity(stateWith([USER("hi")]), { sessionID: "ses_2" as SessionID }).value,
    );

    expect(withKind.action).toBe("accept");
    expect(withoutKind.action).toBe("accept");
    expect(router.calls).toHaveLength(2);
  });

  test("treats a dispatch without kind as primary", () => {
    expect(isPrimaryDispatch(undefined)).toBe(true);
    expect(isPrimaryDispatch("primary")).toBe(true);
  });

  for (const kind of ["compaction", "title", "generate"] as const) {
    test(`never evaluates ${kind} dispatches`, async () => {
      const router = scripted([{ advisorWouldHelp: 1, consequence: 4 }]);
      const { value, counts } = opportunity(stateWith([USER("hi")]), { kind });

      const decision = await domain({
        config: configWith({ mode: "active" }),
        router: router.router,
      }).observe(value);

      expect(decision.action).toBe("skip");
      expect(decision.mode).toBe("active");
      expect(router.calls).toHaveLength(0);
      expect(counts.captures).toBe(0);
      expect(isPrimaryDispatch(kind)).toBe(false);
    });
  }
});

describe("fingerprint suppression", () => {
  test("suppresses an identical opportunity after one evaluation", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    const first = opportunity(stateWith([USER("hi")]));
    const second = opportunity(stateWith([USER("hi")]));

    const accepted = await routing.observe(first.value);
    const suppressed = await routing.observe(second.value);

    expect(accepted.action).toBe("accept");
    expect(suppressed.action).toBe("suppress");
    expect(suppressed.fingerprint).toBe(accepted.fingerprint);
    expect(router.calls).toHaveLength(1);
    expect(second.counts.captures).toBe(1);
  });

  test("evaluates again when a tool result materially changes", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({
      config: configWith({ maxConsultationsPerTurn: 2 }),
      router: router.router,
    });

    const before = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("old")])])).value,
    );
    const after = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("new")])])).value,
    );

    expect(before.action).toBe("accept");
    expect(after.action).toBe("accept");
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(router.calls).toHaveLength(2);
  });
});

describe("policy", () => {
  test("uses the configured thresholds, not hard-coded values", () => {
    const strict = routingConfig();
    expect(acceptsConsultation(strict, { advisorWouldHelp: 0.7, consequence: 3 })).toBe(true);
    expect(acceptsConsultation(strict, { advisorWouldHelp: 0.6999, consequence: 3 })).toBe(false);
    expect(acceptsConsultation(strict, { advisorWouldHelp: 1, consequence: 2 })).toBe(false);

    const relaxed = routingConfig({ advisorWouldHelpThreshold: 0.5, consequenceThreshold: 2 });
    expect(acceptsConsultation(relaxed, { advisorWouldHelp: 0.6, consequence: 2 })).toBe(true);
  });

  test("reads thresholds from live configuration for every opportunity", async () => {
    const configs = [
      configWith(),
      configWith({ advisorWouldHelpThreshold: 0.5, consequenceThreshold: 2 }),
    ];
    let loads = 0;
    const router = scripted([{ advisorWouldHelp: 0.6, consequence: 2 }]);
    const routing = createRoutingDomain({
      loadConfig: async () => configs[Math.min(loads++, configs.length - 1)] as AdvisorConfig,
      router: router.router,
      service: { consult: async () => ({ advice: "x" }) },
    });

    const strict = await routing.observe(opportunity(stateWith([USER("first")])).value);
    const relaxed = await routing.observe(
      opportunity(stateWith([USER("second")], "msg-user-2")).value,
    );

    expect(strict.action).toBe("reject");
    expect(relaxed.action).toBe("accept");
  });
});

describe("router result normalization", () => {
  test("clamps out-of-range probabilities before policy", async () => {
    const high = scripted([{ advisorWouldHelp: 1.5, consequence: 3 }]);
    const accepted = await domain({
      config: configWith({ mode: "active" }),
      router: high.router,
    }).observe(opportunity(stateWith([USER("hi")])).value);
    expect(accepted.action).toBe("accept");
    expect(accepted.assessment?.advisorWouldHelp).toBe(1);

    const low = scripted([{ advisorWouldHelp: -0.5, consequence: 4 }]);
    const rejected = await domain({
      config: configWith({ mode: "active" }),
      router: low.router,
    }).observe(opportunity(stateWith([USER("hi")])).value);
    expect(rejected.action).toBe("reject");
    expect(rejected.assessment?.advisorWouldHelp).toBe(0);
  });

  test("rejects invalid consequences as a router error and fails open", async () => {
    for (const consequence of [2.5, -1, 5]) {
      const router = scripted([{ advisorWouldHelp: 0.9, consequence }]);
      const advisor = countingService();
      const decision = await domain({
        config: configWith({ mode: "active" }),
        router: router.router,
        service: advisor.service,
      }).observe(opportunity(stateWith([USER("hi")])).value);

      expect(decision.action).toBe("fail");
      expect(decision.error).toBeString();
      expect(advisor.calls).toHaveLength(0);
    }
  });

  test("fails open on non-numeric probabilities without consuming the attempt", async () => {
    const router = scripted([
      { advisorWouldHelp: Number.NaN, consequence: 3 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const failed = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(failed.action).toBe("fail");

    const retried = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );
    expect(retried.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("suppresses a retry of the same state after a router error", async () => {
    const router = scripted([new Error("router unavailable")]);
    const routing = domain({ config: configWith(), router: router.router });

    const failed = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const again = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("router unavailable");
    expect(again.action).toBe("suppress");
    expect(router.calls).toHaveLength(1);
  });

  test("carries the router failure classification and policy snapshot into the decision", async () => {
    const failure = {
      errorClass: "Authentication",
      model: "jev-1.13-free",
      attempts: 1,
    };
    const router = scripted([new RouterError("zen routing failed", failure)]);
    const routing = domain({ config: configWith(), router: router.router });

    const decision = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("fail");
    expect(decision.failure).toEqual(failure);
    expect(decision.policy).toEqual({
      advisorWouldHelpThreshold: 0.7,
      consequenceThreshold: 3,
    });
  });

  test("carries raw and normalized consequence plus probability metadata into the decision", async () => {
    const metadata = {
      model: "jev-1.13-free",
      attempts: 1,
      rawConsequence: 2.6,
      consequenceProbabilities: { "0": 0.05, "1": 0.1, "2": 0.6, "3": 0.2, "4": 0.05 },
      consequenceConfidence: 0.9,
    };
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3, metadata }]);
    const routing = domain({ config: configWith({ mode: "observe" }), router: router.router });

    const decision = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("accept");
    expect(decision.assessment?.consequence).toBe(3);
    expect(decision.assessment?.metadata).toEqual(metadata);
  });

  test("fails open at the routing boundary when the router times out", async () => {
    const failure = {
      errorClass: "Timeout",
      model: "jev-1.13-free",
      attempts: 1,
      disposition: "terminal" as const,
    };
    const router = scripted([new RouterError("zen evaluation exceeded 5000ms", failure)]);
    const routing = domain({ config: configWith({ mode: "active" }), router: router.router });

    const decision = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("fail");
    expect(decision.failure).toEqual(failure);
    expect(decision.advice).toBeUndefined();
  });
});

describe("automatic consultation budget", () => {
  test("active skips evaluation once the turn budget is exhausted", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const second = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(second.action).toBe("deny");
    expect(second.mode).toBe("active");
    expect(second.assessment).toBeUndefined();
    expect(second.policy).toEqual({
      advisorWouldHelpThreshold: 0.7,
      consequenceThreshold: 3,
    });
    expect(router.calls).toHaveLength(1);
    expect(advisor.calls).toHaveLength(1);
  });

  test("observe keeps evaluating hypothetically past the exhausted budget", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.8, consequence: 3 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const second = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(second.action).toBe("deny");
    expect(second.assessment).toEqual({ advisorWouldHelp: 0.8, consequence: 3 });
    expect(router.calls).toHaveLength(2);
    expect(advisor.calls).toHaveLength(0);
  });

  test("consumes the attempt even when the automatic consultation fails", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService(new Error("provider exploded"));
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const failed = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const denied = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("provider exploded");
    expect(denied.action).toBe("deny");
    expect(advisor.calls).toHaveLength(1);
  });

  test("classifies automatic consultation failures distinctly from router failures", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService(new Error("provider exploded"));
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const failed = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );

    expect(failed.action).toBe("fail");
    expect(failed.failure).toEqual({
      errorClass: ADVISOR_CONSULT_ERROR_CLASS,
      disposition: "terminal",
    });
  });

  test("applies the budget hypothetically in observe mode", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const second = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(second.action).toBe("deny");
    expect(advisor.calls).toHaveLength(0);
  });

  test("tracks budget independently per session", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const other = await routing.observe(
      opportunity(stateWith([USER("hi")]), { sessionID: "ses_2" as SessionID }).value,
    );

    expect(first.action).toBe("accept");
    expect(other.action).toBe("accept");
    expect(advisor.calls).toHaveLength(2);
  });
});

describe("turn identity", () => {
  test("keeps one turn across tool-driven continuations of the same user message", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const continuation = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("tool done")])])).value,
    );
    const newTurn = await routing.observe(
      opportunity(stateWith([USER("again")], "msg-user-2")).value,
    );

    expect(first.action).toBe("accept");
    expect(continuation.action).toBe("deny");
    expect(newTurn.action).toBe("accept");
    expect(advisor.calls).toHaveLength(2);
  });
});

describe("explicit review marking", () => {
  test("markReviewed suppresses an equivalent automatic opportunity before evaluation", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    const entries = [USER("hi")];

    routing.markReviewed("ses_1" as SessionID, "msg-user-1", entries);
    const decision = await routing.observe(opportunity(stateWith(entries)).value);

    expect(decision.action).toBe("suppress");
    expect(router.calls).toHaveLength(0);
  });

  test("markReviewed does not consume the consultation budget", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    routing.markReviewed("ses_1" as SessionID, "msg-user-1", [USER("hi")]);
    const accepted = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("new material")])])).value,
    );

    expect(accepted.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("markReviewed only affects the marked turn", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    routing.markReviewed("ses_1" as SessionID, "msg-user-1", [USER("hi")]);

    const nextTurn = await routing.observe(
      opportunity(stateWith([USER("next")], "msg-user-2")).value,
    );

    expect(nextTurn.action).toBe("accept");
    expect(router.calls).toHaveLength(1);
  });

  test("advisor-origin material alone keeps an explicitly reviewed state suppressed", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    routing.markReviewed("ses_1" as SessionID, "msg-user-1", [USER("hi")]);

    const decision = await routing.observe(
      opportunity(
        stateWith([
          USER("hi"),
          ASSISTANT(false, [
            {
              type: "tool-call",
              id: "call_advisor",
              name: "advisor",
              status: "completed",
              input: {},
            },
            { type: "tool-result", id: "call_advisor", name: "advisor", text: "advice" },
          ]),
        ]),
      ).value,
    );

    expect(decision.action).toBe("suppress");
    expect(router.calls).toHaveLength(0);
  });

  test("meaningful non-advisor material re-enables evaluation after an explicit review", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    routing.markReviewed("ses_1" as SessionID, "msg-user-1", [USER("hi")]);

    const decision = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("new evidence")])])).value,
    );

    expect(decision.action).toBe("accept");
    expect(router.calls).toHaveLength(1);
  });
});

describe("turn state bounds", () => {
  test("evicts the oldest session without disturbing suppression for live sessions", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const routing = domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      maxSessions: 2,
    });
    const opportunities = (sessionID: SessionID) =>
      opportunity(stateWith([USER("hi")]), { sessionID });

    const first = await routing.observe(opportunities("ses_1" as SessionID).value);
    const repeated = await routing.observe(opportunities("ses_1" as SessionID).value);
    const second = await routing.observe(opportunities("ses_2" as SessionID).value);
    const third = await routing.observe(opportunities("ses_3" as SessionID).value);
    const revived = await routing.observe(opportunities("ses_1" as SessionID).value);
    const live = await routing.observe(opportunities("ses_3" as SessionID).value);

    expect(first.action).toBe("accept");
    expect(repeated.action).toBe("suppress");
    expect(second.action).toBe("accept");
    expect(third.action).toBe("accept");
    expect(revived.action).toBe("accept");
    expect(live.action).toBe("suppress");
    expect(router.calls).toHaveLength(4);
  });
});

describe("session cleanup", () => {
  test("forget clears fingerprint suppression and budget state for a session", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const routing = domain({ config: configWith(), router: router.router });

    const first = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const suppressed = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    routing.forget("ses_1" as SessionID);
    const afterForget = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(first.action).toBe("accept");
    expect(suppressed.action).toBe("suppress");
    expect(afterForget.action).toBe("accept");
    expect(router.calls).toHaveLength(2);
  });

  test("forget also clears the router's session-scoped state", () => {
    const forgotten: SessionID[] = [];
    const router: AdvisorRouter = {
      evaluate: async () => ({ advisorWouldHelp: 0.9, consequence: 4 }),
      forget: (sessionID) => {
        forgotten.push(sessionID);
      },
    };

    domain({ config: configWith(), router }).forget("ses_1" as SessionID);

    expect(forgotten).toEqual(["ses_1"]);
  });
});

describe("fail-open behavior", () => {
  test("capture failures fail open without consuming the budget", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const broken: RoutingOpportunity = {
      sessionID: "ses_1" as SessionID,
      capture: async () => {
        throw new Error("session read failed");
      },
    };

    const failed = await routing.observe(broken);
    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("session read failed");
    expect(router.calls).toHaveLength(0);

    const recovered = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(recovered.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("configuration failures fail open without capturing", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: new Error("configuration unreadable"),
      router: router.router,
    }).observe(value);

    expect(decision.action).toBe("fail");
    expect(decision.mode).toBeUndefined();
    expect(decision.error).toContain("configuration unreadable");
    expect(router.calls).toHaveLength(0);
    expect(counts.captures).toBe(0);
  });
});

describe("model-aware budget", () => {
  test("resolves the inherited executor model and fits the transcript", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService({ advice: "check it" });
    const resolved: ModelReference[] = [];
    const executorModel: ModelReference = { providerID: "opencode", id: "jev-1.13" };

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async (model) => {
        resolved.push(model);
        return { context: 200_000, output: 32_000 };
      },
    }).observe(
      opportunity(stateWith([USER("migrate the schema")], "msg-user-1", executorModel)).value,
    );

    expect(decision.action).toBe("accept");
    expect(resolved).toEqual([executorModel]);
    expect(advisor.calls).toHaveLength(1);
    expect(decision.advisorContext).toMatchObject({
      complete: true,
      omittedEntries: 0,
      includedEntries: 1,
      inputBudget: 150_000,
    });
    expect(decision.advisorContext?.estimatedTokens).toBeLessThanOrEqual(150_000);
  });

  test("resolves the pinned advisor model for the limit lookup", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const resolved: ModelReference[] = [];
    const pinned: ModelReference = { providerID: "anthropic", id: "claude-sonnet-4" };

    const decision = await domain({
      config: {
        advisor: { model: pinned },
        routing: routingConfig({ mode: "active" }),
      },
      router: router.router,
      resolveLimits: async (model) => {
        resolved.push(model);
        return { context: 200_000, output: 32_000 };
      },
    }).observe(
      opportunity(stateWith([USER("hi")], "msg-user-1", { providerID: "opencode", id: "jev-1.13" }))
        .value,
    );

    expect(decision.action).toBe("accept");
    expect(resolved).toEqual([pinned]);
  });

  test("unknown limits fail open without consulting or consuming the budget", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    let available = false;
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => (available ? { context: 200_000, output: 32_000 } : undefined),
    });

    const skipped = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(skipped).toMatchObject({
      action: "skip",
      mode: "active",
      skipReason: ADVISOR_LIMITS_SKIP_REASON,
      fingerprint: expect.any(String),
      assessment: { advisorWouldHelp: 0.9, consequence: 4 },
    });
    expect(skipped.error).toBeString();
    expect(advisor.calls).toHaveLength(0);

    available = true;
    const accepted = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );
    expect(accepted.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("malformed limits fail open without consuming the budget", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    let limits: ModelLimits | undefined = { context: 100, output: 200 };
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => limits,
    });

    const skipped = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(skipped.action).toBe("skip");
    expect(skipped.skipReason).toBe(ADVISOR_LIMITS_SKIP_REASON);
    expect(advisor.calls).toHaveLength(0);

    limits = { context: 200_000, output: 32_000 };
    const accepted = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );
    expect(accepted.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("resolver failures fail open", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => {
        throw new Error("catalog exploded");
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("skip");
    expect(advisor.calls).toHaveLength(0);
  });

  test("an unknown advisor model fails open", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    let resolved = 0;
    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => {
        resolved += 1;
        return { context: 200_000, output: 32_000 };
      },
    }).observe(
      opportunity({
        entries: [USER("hi")],
        lastUserMessageID: "msg-user-1",
      }).value,
    );

    expect(decision.action).toBe("skip");
    expect(decision.skipReason).toBe(ADVISOR_LIMITS_SKIP_REASON);
    expect(resolved).toBe(0);
    expect(advisor.calls).toHaveLength(0);
  });

  test("reduces the transcript for a small-context advisor instead of rejecting", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const history = USER(`OLD-${"x".repeat(8000)}`);

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => ({ context: 2000, output: 1500 }),
    }).observe(opportunity(stateWith([history, USER("CURRENT-TASK")])).value);

    expect(decision.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
    expect(advisor.calls[0]?.transcript).toContain("CURRENT-TASK");
    expect(advisor.calls[0]?.transcript).not.toContain("OLD-");
    expect(decision.advisorContext?.complete).toBe(false);
    expect(decision.advisorContext?.omittedEntries).toBe(1);
    expect(decision.advisorContext?.inputBudget).toBe(500);
  });

  test("observe never resolves limits or builds the projection", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    let resolved = 0;
    let projected = 0;
    const decision = await domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      resolveLimits: async () => {
        resolved += 1;
        return { context: 200_000, output: 32_000 };
      },
      project: (state, options) => {
        projected += 1;
        return buildAdvisorProjection(state, options);
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("accept");
    expect(decision.advisorContext).toBeUndefined();
    expect(resolved).toBe(0);
    expect(projected).toBe(0);
  });

  test("rejected opportunities never resolve limits or build the projection", async () => {
    const router = scripted([{ advisorWouldHelp: 0.1, consequence: 0 }]);
    let resolved = 0;
    let projected = 0;
    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      resolveLimits: async () => {
        resolved += 1;
        return { context: 200_000, output: 32_000 };
      },
      project: (state, options) => {
        projected += 1;
        return buildAdvisorProjection(state, options);
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision.action).toBe("reject");
    expect(resolved).toBe(0);
    expect(projected).toBe(0);
  });

  test("budget-denied opportunities never resolve limits or build the projection", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    let projected = 0;
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      resolveLimits: async () => ({ context: 200_000, output: 32_000 }),
      project: (state, options) => {
        projected += 1;
        return buildAdvisorProjection(state, options);
      },
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const denied = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(denied.action).toBe("deny");
    expect(projected).toBe(1);
  });

  test("projection errors skip without consuming the budget", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    let failing = true;
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      project: (state, options) => {
        if (failing) throw new RangeError("cannot fit the mandatory framing");
        return buildAdvisorProjection(state, options);
      },
    });

    const skipped = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(skipped.action).toBe("skip");
    expect(skipped.skipReason).toBe(ADVISOR_PROJECTION_SKIP_REASON);
    expect(skipped.error).toContain("mandatory framing");
    expect(skipped.failure).toBeUndefined();
    expect(advisor.calls).toHaveLength(0);

    failing = false;
    const accepted = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );

    expect(accepted.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("passes the resolved advisor model into the consultation", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const executorModel: ModelReference = { providerID: "opencode", id: "jev-1.13" };

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => ({ context: 200_000, output: 32_000 }),
    }).observe(opportunity(stateWith([USER("hi")], "msg-user-1", executorModel)).value);

    expect(decision.action).toBe("accept");
    expect(advisor.calls[0]?.advisorModel).toEqual(executorModel);
  });
});

describe("review evidence and consultation outcomes", () => {
  test("advisor entries reach only the projection, not the fingerprint or Jev", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const entries = [USER("CURRENT-TASK")];
    const advisorEntries: SerializedEntry[] = [
      { role: "system", text: "RETAINED-REVIEW-EVIDENCE" },
    ];

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => ({ context: 200_000, output: 32_000 }),
    }).observe(
      opportunity({
        entries,
        lastUserMessageID: "msg-user-1",
        executorModel: DEFAULT_EXECUTOR_MODEL,
        advisorEntries,
      }).value,
    );

    expect(decision.action).toBe("accept");
    expect(router.calls[0]?.entries).toEqual(entries);
    expect(advisor.calls[0]?.transcript).toContain("RETAINED-REVIEW-EVIDENCE");
    expect(advisor.calls[0]?.transcript).toContain("CURRENT-TASK");
  });

  test("marks advisor timeouts distinctly from other consultation failures", async () => {
    const timedOut = await domain({
      config: configWith({ mode: "active" }),
      router: scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]).router,
      service: {
        consult: async () => {
          throw new AdvisorTimeoutError(20);
        },
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(timedOut).toMatchObject({
      action: "fail",
      advisorTimedOut: true,
      advisorOutcome: "timeout",
      advisorInvocations: 1,
    });
    expect(typeof timedOut.advisorLatencyMs).toBe("number");

    const failed = await domain({
      config: configWith({ mode: "active" }),
      router: scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]).router,
      service: {
        consult: async () => {
          throw new Error("provider exploded");
        },
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(failed).toMatchObject({
      action: "fail",
      advisorTimedOut: false,
      advisorOutcome: "failed",
      advisorInvocations: 1,
    });
  });

  test("passes the per-opportunity onAdvisorStart into the consultation", async () => {
    const starts: string[] = [];
    const service: AdvisorService = {
      consult: async (input) => {
        input.onStart?.();
        return { advice: "advice" };
      },
    };

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]).router,
      service,
      resolveLimits: async () => ({ context: 200_000, output: 32_000 }),
    }).observe(
      opportunity(stateWith([USER("hi")]), {
        onAdvisorStart: () => starts.push("started"),
      }).value,
    );

    expect(decision.action).toBe("accept");
    expect(starts).toEqual(["started"]);
  });
});

describe("operation invalidation", () => {
  test("an invalidated opportunity skips before capture without evaluating", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const { value, counts } = opportunity(stateWith([USER("hi")]), { isCurrent: () => false });

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision).toMatchObject({
      action: "skip",
      mode: "active",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(counts.captures).toBe(0);
    expect(router.calls).toHaveLength(0);
    expect(advisor.calls).toHaveLength(0);
  });

  test("invalidation during capture skips before Jev and writes no turn state", async () => {
    let current = true;
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });
    const value: RoutingOpportunity = {
      sessionID: "ses_1" as SessionID,
      isCurrent: () => current,
      capture: async () => {
        current = false;
        return stateWith([USER("hi")]);
      },
    };

    const decision = await routing.observe(value);

    expect(decision).toMatchObject({
      action: "skip",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(router.calls).toHaveLength(0);
    expect(advisor.calls).toHaveLength(0);

    current = true;
    const retried = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(retried.action).toBe("accept");
    expect(router.calls).toHaveLength(1);
  });

  test("invalidation during Jev evaluation prevents any Advisor start", async () => {
    let current = true;
    const advisor = countingService();
    const starts: string[] = [];
    const router: AdvisorRouter = {
      evaluate: async () => {
        current = false;
        return { advisorWouldHelp: 0.9, consequence: 4 };
      },
    };

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router,
      service: advisor.service,
    }).observe(
      opportunity(stateWith([USER("hi")]), {
        isCurrent: () => current,
        onAdvisorStart: () => starts.push("started"),
      }).value,
    );

    expect(decision).toMatchObject({
      action: "skip",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(advisor.calls).toHaveLength(0);
    expect(starts).toEqual([]);
  });

  test("invalidation during the model-limit lookup skips before consulting", async () => {
    let current = true;
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
      resolveLimits: async () => {
        current = false;
        return { context: 200_000, output: 32_000 };
      },
    }).observe(opportunity(stateWith([USER("hi")]), { isCurrent: () => current }).value);

    expect(decision).toMatchObject({
      action: "skip",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(advisor.calls).toHaveLength(0);
  });

  test("invalidation during consultation skips quietly without refunding the attempt", async () => {
    let current = true;
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const consulted: AdvisorConsultationInput[] = [];
    const service: AdvisorService = {
      consult: async (input) => {
        consulted.push(input);
        current = false;
        return { advice: "late advice" };
      },
    };
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service,
    });

    const late = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])]), {
        isCurrent: () => current,
      }).value,
    );

    expect(late).toMatchObject({
      action: "skip",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(consulted).toHaveLength(1);

    current = true;
    const denied = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(denied.action).toBe("deny");
    expect(consulted).toHaveLength(1);
  });

  test("a service invalidation error becomes a quiet skip", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: {
        consult: async () => {
          throw new AdvisorInvalidatedError();
        },
      },
    }).observe(opportunity(stateWith([USER("hi")])).value);

    expect(decision).toMatchObject({
      action: "skip",
      skipReason: ADVISOR_OPERATION_INVALIDATED_SKIP_REASON,
    });
    expect(decision.advisorInvocations).toBeUndefined();
    expect(decision.error).toBeUndefined();
  });

  test("propagates the isCurrent predicate into the consultation", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const isCurrent = () => true;

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    }).observe(opportunity(stateWith([USER("hi")]), { isCurrent }).value);

    expect(decision.action).toBe("accept");
    expect(advisor.calls[0]?.isCurrent).toBe(isCurrent);
  });

  test("a fresh operation after invalidation is unaffected", async () => {
    let current = false;
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const aborted = await routing.observe(
      opportunity(stateWith([USER("hi")]), { isCurrent: () => current }).value,
    );
    expect(aborted.action).toBe("skip");

    current = true;
    const accepted = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );
    expect(accepted.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });
});
